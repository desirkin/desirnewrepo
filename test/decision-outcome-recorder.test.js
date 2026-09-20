// DECISION OUTCOME RECORDER + STORE (Ticket 3 step 2, 2026-09-15). The dormant maturation engine and its durable store.
// No database, no network: journal pages, the candle source and the clock are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecisionOutcomeRecorder } from '../learning/decision-outcome-recorder.js';
import { openDecisionOutcomeStore, decisionOutcomeError } from '../learning/decision-outcome-store.js';

// A 1m series (labels.js validateCandleSeriesRow shape) of `n` forward closes from the anchor, ref close 100.
function seriesFor(anchorSec, n, { retrievedSec = null } = {}) {
  const refOpenSec = anchorSec - 60;
  const closes = [100]; for (let i = 1; i <= n; i += 1) closes.push(100 + i);
  const candles = closes.map((c, i) => { const open = refOpenSec + i * 60; const prev = i === 0 ? c : closes[i - 1]; return [open, prev, Math.max(prev, c) + 1, Math.min(prev, c) - 1, c, 10]; });
  const index = new Map(candles.map((c, i) => [c[0], i]));
  const lastOpen = refOpenSec + (closes.length - 1) * 60;
  const rSec = retrievedSec ?? lastOpen + 60;
  return { symbol: 'BTC', intervalSec: 60, retrievedSec: rSec, retrievedTsMs: rSec * 1000, coverageEndSec: rSec, candles, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec: lastOpen };
}

// an in-memory store fake matching the injected interface
function fakeStore() {
  const ids = new Set(); const rows = []; let cur = 0;
  return { has: (id) => ids.has(id), count: () => ids.size, cursor: () => cur, setCursor: (s) => { if (s >= cur) cur = s; }, append: (r) => { if (ids.has(r.decisionId)) return false; assert.equal(decisionOutcomeError(r), null, JSON.stringify(r).slice(0, 200)); ids.add(r.decisionId); rows.push(r); return true; }, rows: () => rows };
}

const decisionEvent = (seq, decisionId, assetId, anchorSec, state = 'ENTRY_RESERVED') => ({ seq, event: { type: 'DECISION_RECORDED', payload: { decisionId, assetId, decisionKnownAtTs: anchorSec * 1000, state } } });
const otherEvent = (seq) => ({ seq, event: { type: 'RESERVATION_OPENED', payload: {} } });
const pager = (events) => async (afterSeq, limit) => events.filter((e) => e.seq > afterSeq).slice(0, limit);

test('DOR-1. records the bite+continuation for a matured decision, once, and advances the cursor over interleaved events', () => {
  const anchor = 1_000_000 * 60 + 60;
  const events = [decisionEvent(1, 'dec-a', 'BTC', anchor), otherEvent(2), decisionEvent(3, 'dec-b', 'ETH', anchor)];
  const store = fakeStore();
  const now = (anchor + 15 * 60) * 1000 + 60_000; // both decisions matured
  const rec = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: (coin) => seriesFor(anchor, 15), store, clock: () => now });
  return rec.tick().then((s) => {
    assert.equal(s.scanned, 2); assert.equal(s.recorded, 2); assert.equal(s.cursor, 3);
    const a = store.rows().find((r) => r.decisionId === 'dec-a');
    assert.equal(a.assetId, 'BTC'); assert.equal(a.yardstick.bite.state, 'KNOWN'); assert.equal(a.yardstick.continuation.state, 'KNOWN');
    // a second tick over the same journal records nothing new (idempotent)
    return rec.tick().then((s2) => { assert.equal(s2.recorded, 0); assert.equal(store.count(), 2); });
  });
});

test('DOR-2. an un-matured decision is left pending: the cursor stops before it and no later decision is recorded', async () => {
  const anchor = 2_000_000 * 60 + 60;
  const events = [decisionEvent(1, 'dec-a', 'BTC', anchor), decisionEvent(2, 'dec-b', 'ETH', anchor)];
  const store = fakeStore();
  const now = (anchor + 5 * 60) * 1000; // only 5 minutes elapsed: the 15m continuation is not due
  const rec = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: (coin) => seriesFor(anchor, 6), store, clock: () => now });
  const s = await rec.tick();
  assert.equal(s.recorded, 0); assert.equal(s.pendingSeq, 1); assert.equal(s.cursor, 0, 'the cursor never advances past a pending decision');
});

test('DOR-3. due but the candle data has not caught up -> pending; a later tick with data records it', async () => {
  const anchor = 3_000_000 * 60 + 60;
  const events = [decisionEvent(1, 'dec-a', 'BTC', anchor)];
  const store = fakeStore();
  let hasData = false;
  const rec = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: () => (hasData ? seriesFor(anchor, 15) : seriesFor(anchor, 3)), store, clock: () => (anchor + 15 * 60) * 1000 + 60_000 });
  // series only reaches 3 minutes: the 15m continuation coverage ends early -> CENSORED, which is terminal, so it records.
  // To exercise the NOT_YET_KNOWN pending branch, give a series whose retrieval clock is in the future of now:
  const future = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: () => ({ ...seriesFor(anchor, 15), retrievedTsMs: (anchor + 100 * 60) * 1000, retrievedSec: anchor + 100 * 60 }), store, clock: () => (anchor + 16 * 60) * 1000 });
  const s0 = await future.tick();
  assert.equal(s0.recorded, 0); assert.equal(s0.pendingSeq, 1, 'a series whose knowledge clock is ahead of now leaves the decision pending');
  hasData = true;
  const s1 = await rec.tick();
  assert.equal(s1.recorded, 1); assert.equal(store.rows()[0].yardstick.continuation.state, 'KNOWN');
});

test('DOR-4. the hard deadline force-closes a decision whose data never arrives, so the cursor cannot wedge', async () => {
  const anchor = 4_000_000 * 60 + 60;
  const events = [decisionEvent(1, 'dec-a', 'BTC', anchor, 'NO_TRADE'), decisionEvent(2, 'dec-b', 'ETH', anchor)];
  const store = fakeStore();
  const now = (anchor * 1000) + 61 * 60_000; // past maxWaitMs (60m) for both
  const rec = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: () => null, store, clock: () => now });
  const s = await rec.tick();
  assert.equal(s.recorded, 2); assert.equal(s.unavailable, 2); assert.equal(s.cursor, 2);
  const a = store.rows().find((r) => r.decisionId === 'dec-a');
  assert.equal(a.decisionState, 'NO_TRADE', 'refusals are recorded too'); assert.equal(a.yardstick.availability.state, 'OUTCOME_UNAVAILABLE');
});

test('DOR-5. the durable JSONL store is idempotent and cursor-durable across reopen', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serpent-dos-'));
  try {
    const anchor = 5_000_000 * 60 + 60;
    const events = [decisionEvent(1, 'dec-a', 'BTC', anchor), decisionEvent(2, 'dec-b', 'ETH', anchor)];
    const now = (anchor + 15 * 60) * 1000 + 60_000;
    const store1 = openDecisionOutcomeStore({ dir });
    const rec1 = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: () => seriesFor(anchor, 15), store: store1, clock: () => now });
    return rec1.tick().then((s1) => {
      assert.equal(s1.recorded, 2); assert.equal(store1.cursor(), 2);
      // reopen: the id index and cursor rebuild from disk; a fresh recorder records nothing new
      const store2 = openDecisionOutcomeStore({ dir });
      assert.equal(store2.count(), 2); assert.equal(store2.cursor(), 2);
      const rec2 = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: () => seriesFor(anchor, 15), store: store2, clock: () => now });
      return rec2.tick().then((s2) => { assert.equal(s2.recorded, 0); assert.equal(store2.count(), 2); });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DOR-6. PUBLISH-FIX-83 item 17: a horizon CENSORED because the closed-bar coverage is one bar short, or a series that is absent / lagging, waits (NOT final) until the hard deadline; the bar arriving later records KNOWN; the cursor is written once per page, not per row', async () => {
  const anchor = 5_000_000 * 60 + 60;
  const events = [decisionEvent(1, 'dec-a', 'BTC', anchor, 'NO_TRADE'), otherEvent(2), decisionEvent(3, 'dec-b', 'ETH', anchor + 60, 'NO_TRADE')];
  const store = fakeStore(); let cursorWrites = 0; const counting = { ...store, setCursor: (s) => { cursorWrites += 1; store.setCursor(s); } };
  let bars = 14; // one bar short of the 15-minute continuation at first look
  let clockNow = (anchor + 16 * 60) * 1000;
  const rec = createDecisionOutcomeRecorder({ readPage: pager(events), seriesSource: (coin) => (coin === 'BTC' ? seriesFor(anchor, bars) : null), store: counting, clock: () => clockNow });
  const s0 = await rec.tick(); assert.equal(s0.recorded, 0, 'CENSORED at first look is not written'); assert.equal(s0.pendingSeq, 1); assert.equal(s0.waiting, 1); assert.equal(store.cursor(), 0);
  bars = 15; clockNow += 3 * 60_000; // the thin coin's bar lands three minutes later
  const s1 = await rec.tick(); assert.equal(s1.recorded, 1); assert.equal(store.rows()[0].yardstick.continuation.state, 'KNOWN', 'the late bar made it KNOWN instead of a permanent CENSORED');
  assert.equal(s1.pendingSeq, 3, 'ETH: no series yet -> waiting, not OUTCOME_UNAVAILABLE'); assert.equal(store.cursor(), 2, 'the cursor advanced over the recorded row and the interleaved event'); assert.equal(cursorWrites, 1, 'ONE cursor write for the tick, not one per row');
  clockNow = (anchor + 61 * 60) * 1000; // past the 60-minute hard deadline: whatever stands is written, the cursor cannot wedge
  const s2 = await rec.tick(); assert.equal(s2.recorded, 1); assert.equal(store.rows()[1].yardstick.availability.state, 'OUTCOME_UNAVAILABLE'); assert.equal(store.cursor(), 3); assert.equal(cursorWrites, 2);
});
