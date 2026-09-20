// PUBLISH-FIX-83 — review findings in the ears (rumint/poller.js): the checkpoint symbol bound is kept by pruning (before this a
// tracked set that drifted past 64 symbols saved a checkpoint the loader refuses, and every later restart was WITHHELD forever); a
// checkpoint that would not load back is never written; a WITHHELD init retries on a back-off (5 s -> 5 min), not once per tick; and
// the checkpoint is saved when the state advanced, not every second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.RUMINT_ENABLED = 'true';
const { startRumint } = await import('../rumint/poller.js');
const { validateCheckpoint, MAX_SYMBOLS, emptyBaseline, RUMINT_CHECKPOINT_VERSION, PROVIDER, providerSymbolFor, COVERAGE_SAMPLED } = await import('../rumint/truth.js');
test.after(() => { delete process.env.RUMINT_ENABLED; });

const CFG = (coins = ['BTC']) => ({ universe: coins, rumint: { enabled: true, zThreshold: 3, stalkTtlMin: 60, pollHotSec: 300, pollWarmSec: 1200, hourlyBudget: 500, spacingMs: 1, backoffMin: 15 } });
const dirs = [];
const freshDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-rumint-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const statusOf = (d) => JSON.parse(readFileSync(path.join(d, 'rumint', 'status.json'), 'utf8'));
const T0 = Date.parse('2026-09-02T12:30:00Z');

function memStore() {
  return {
    state: null, failLoad: false, loads: 0, saves: 0,
    async load() { this.loads += 1; if (this.failLoad) return { outcome: 'UNAVAILABLE', error: 'induced load failure' }; return this.state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(this.state) }; },
    async save(s) { this.saves += 1; this.state = structuredClone(s); return { durable: true }; },
  };
}
const page = (messages) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages }) });
const msg = (id, atMs) => ({ id, created_at: new Date(atMs).toISOString(), entities: { sentiment: { basic: null } } });
const scripted = (queue) => { const calls = []; const impl = async (url) => { calls.push(url); const next = queue.shift(); if (!next) throw new Error('unscripted fetch: ' + url); return next; }; impl.calls = calls; return impl; };

const fullCheckpoint = (atMs, symbols) => {
  const baselines = {}; const health = {};
  for (const [i, sym] of symbols.entries()) {
    const b = emptyBaseline(sym, sym.replace(/\.X$/, '')); b.baselineRevision = 1; b.lastMsgId = '1';
    const hourKey = new Date(atMs - (i + 2) * 3_600_000).toISOString().slice(0, 13); // older symbols observed longer ago
    b.buckets[hourKey] = { count: 1, bull: 0, bear: 0, successfulPolls: 1, firstPollTs: new Date(atMs - (i + 2) * 3_600_000).toISOString(), lastPollTs: new Date(atMs - (i + 2) * 3_600_000).toISOString(), coverage: COVERAGE_SAMPLED };
    baselines[sym] = b; health[sym] = { failureStreak: 0, unavailableUntil: 0, cooldownLevel: 0, lastError: null, lastErrorTs: null, lastFailureKind: null };
  }
  return { version: RUMINT_CHECKPOINT_VERSION, savedTs: new Date(atMs).toISOString(), provider: PROVIDER, collectorVersion: 'RUMINT-R1A', baselines, hyped: { sessionDate: null, state: 'BUILDING', symbols: [], finalizedTs: null, identity: null, coverage: null }, providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [], symbols: health }, pendingEvents: [], pollTransaction: null, counters: {} };
};

test('FIX83-R2. a checkpoint at the symbol bound plus a newly tracked coin is saved PRUNED to the bound: the tracked symbol kept, the least recently observed untracked one dropped — the saved row always loads back', async () => {
  const d = freshDir(); const store = memStore();
  const olds = Array.from({ length: MAX_SYMBOLS }, (_, i) => `OLD${String(i).padStart(2, '0')}.X`);
  const cp = fullCheckpoint(T0, olds); assert.equal(validateCheckpoint(cp), null, 'the fixture itself is a valid full checkpoint'); store.state = cp;
  const clock = { ms: T0 }; const queue = [page([msg(50, T0 - 60_000)])]; const fetchImpl = scripted(queue);
  const r = startRumint({ log: () => {}, config: CFG(['BTC']), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  try {
    clock.ms += 5000; await r.tickOnce(); assert.equal(fetchImpl.calls.length, 1, 'restored and polling');
    assert.equal(statusOf(d).initState, 'RESTORED_DURABLE');
    const saved = store.state; assert.equal(validateCheckpoint(saved), null, `the saved checkpoint loads back: ${validateCheckpoint(saved)}`);
    const syms = Object.keys(saved.baselines); assert.equal(syms.length, MAX_SYMBOLS); assert.ok(syms.includes(providerSymbolFor('BTC')), 'the tracked symbol is kept');
    assert.ok(!syms.includes('OLD63.X'), 'the least recently observed untracked symbol was pruned'); assert.ok(syms.includes('OLD00.X'), 'the most recently observed untracked symbols stay');
    assert.ok(Object.keys(saved.providerHealth.symbols).length <= MAX_SYMBOLS); assert.ok(!('OLD63.X' in saved.providerHealth.symbols));
    assert.equal(statusOf(d).saveDetail, null); assert.equal(statusOf(d).status, 'HEALTHY');
    const local = JSON.parse(readFileSync(path.join(d, 'rumint', 'checkpoint.json'), 'utf8')); assert.equal(validateCheckpoint(local), null, 'the local cache is the same pruned truth');
  } finally { await r.stop(); }
});

test('FIX83-R3. a WITHHELD initialization retries the durable load on a back-off (5 s, 10 s, 20 s ... 5 min), never once per tick; it initializes on the first successful retry', async () => {
  const d = freshDir(); const store = memStore(); store.failLoad = true;
  const clock = { ms: T0 }; const queue = []; const fetchImpl = scripted(queue); const logs = [];
  const r = startRumint({ log: (m) => logs.push(String(m)), config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  try {
    await r.tickOnce(); assert.equal(store.loads, 1); assert.equal(statusOf(d).status, 'WITHHELD_DURABLE_UNAVAILABLE');
    for (let i = 0; i < 4; i += 1) { clock.ms += 1000; await r.tickOnce(); } assert.equal(store.loads, 1, 'no retry inside the first 5 s');
    clock.ms += 1000; await r.tickOnce(); assert.equal(store.loads, 2, 'retried at 5 s');
    clock.ms += 9_000; await r.tickOnce(); assert.equal(store.loads, 2, 'the second wait is 10 s'); clock.ms += 1000; await r.tickOnce(); assert.equal(store.loads, 3);
    for (let i = 0; i < 6; i += 1) { clock.ms += 600_000; await r.tickOnce(); } assert.equal(store.loads, 9, 'once per tick when ticks are 10 minutes apart: the cap is 5 minutes, not longer');
    assert.equal(logs.filter((l) => l.includes('WITHHELD_DURABLE_UNAVAILABLE')).length, 1, 'the withheld state is logged once, not on every retry');
    assert.ok(!existsSync(path.join(d, 'rumint', 'checkpoint.json')), 'no checkpoint save while withheld');
    store.failLoad = false; clock.ms += 300_000; queue.push(page([msg(50, clock.ms - 60_000)])); await r.tickOnce();
    assert.equal(statusOf(d).initState, 'FRESH_START'); assert.equal(fetchImpl.calls.length, 1, 'polling begins on the successful retry');
  } finally { await r.stop(); }
});

test('FIX83-R1. the checkpoint is saved when the state ADVANCED and the durable row is rewritten at most once a minute; an idle tick saves nothing', async () => {
  const d = freshDir(); const store = memStore();
  const clock = { ms: T0 }; const queue = [page([msg(50, T0 - 60_000)])]; const fetchImpl = scripted(queue);
  const r = startRumint({ log: () => {}, config: CFG(['BTC']), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  try {
    clock.ms += 5000; await r.tickOnce(); assert.equal(fetchImpl.calls.length, 1); const savesAfterPoll = store.saves; assert.ok(savesAfterPoll >= 1, 'the poll advancement is followed by its save');
    const before = store.saves; for (let i = 0; i < 30; i += 1) { clock.ms += 1000; await r.tickOnce(); } assert.equal(store.saves, before, '30 idle ticks: no durable rewrite of the same bytes');
    assert.equal(statusOf(d).status, 'HEALTHY');
  } finally { await r.stop(); }
});
