// BROAD-KRAKEN 1m SERIES SOURCE (Ticket 3 step 3, 2026-09-15). Reads the collector's rolling segments into the
// label-series shape the yardstick consumes. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBroadKrakenSeriesSource } from '../learning/broad-kraken-series.js';
import { scoreDecisionYardstick } from '../learning/decision-yardstick.js';

function closedCandle(coin, openSec, close, receivedTs) {
  return JSON.stringify({ recordVersion: 'broad-kraken-record-v2', recordId: 'bkr2-x', recordType: 'OHLC', quality: 'CONSERVATIVE_CLOSED', channel: 'ohlc', market: { canonicalCoin: coin, pairKey: `${coin}USD`, nativeBase: coin, catalogWsname: `${coin}/USD` }, periodStartTs: openSec * 1000, periodEndTs: openSec * 1000 + 60_000, receivedTs, recordedTs: receivedTs, payload: { open: close - 0.5, high: close + 1, low: close - 1, close, vwap: close, trades: 5, volumeBase: 3, messageType: 'closed', finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', learningEligible: false } });
}

function seedSegments(dataDir, lines) {
  const dir = path.join(dataDir, 'broad-kraken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events-000001.jsonl'), lines.join('\n') + '\n');
}

test('BKS-1. builds a coin series from closed candles and the yardstick scores it', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'serpent-bks-'));
  try {
    const refOpenSec = 6_000_000 * 60; const anchorSec = refOpenSec + 60;
    // each closed candle is received when it closes (receivedTs = periodEndTs) — the realistic knowledge clock
    const recvAt = (openSec) => openSec * 1000 + 60_000;
    const lines = [];
    // reference bar (opens at refOpenSec, close 100) then 15 forward bars 101..115, plus noise for another coin
    lines.push(closedCandle('BTC', refOpenSec, 100, recvAt(refOpenSec)));
    for (let i = 1; i <= 15; i += 1) lines.push(closedCandle('BTC', refOpenSec + i * 60, 100 + i, recvAt(refOpenSec + i * 60)));
    lines.push(closedCandle('ETH', refOpenSec, 50, recvAt(refOpenSec)));
    lines.push('{ torn line');
    lines.push(JSON.stringify({ recordType: 'TICKER', quality: 'OBSERVED', market: { canonicalCoin: 'BTC' } })); // must be ignored
    seedSegments(dataDir, lines);
    const source = createBroadKrakenSeriesSource({ dataDir, now: () => Date.now() });
    const s = source('BTC', { asOfTs: (anchorSec + 15 * 60) * 1000 + 60_000 });
    assert.ok(s); assert.equal(s.symbol, 'BTC'); assert.equal(s.count, 16); assert.equal(s.firstOpenSec, refOpenSec);
    assert.equal(source('SOL', { asOfTs: Date.now() }), null, 'a coin with no candles is absent');
    const y = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: anchorSec * 1000, series: s, asOfTs: (anchorSec + 15 * 60) * 1000 + 60_000 });
    assert.equal(y.bite.state, 'KNOWN'); assert.equal(y.continuation.state, 'KNOWN');
    assert.equal(y.reference.price, 100);
    assert.equal(y.bite.logReturnPct, Number((100 * Math.log(105 / 100)).toFixed(4)));
    assert.equal(y.continuation.logReturnPct, Number((100 * Math.log(115 / 100)).toFixed(4)));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('BKS-2. absent collector dir yields no series (honest, never a fabricated one); the TTL caches the rebuild', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'serpent-bks-'));
  try {
    let clock = 1_000;
    const source = createBroadKrakenSeriesSource({ dataDir, now: () => clock, ttlMs: 30_000 });
    assert.equal(source('BTC', { asOfTs: clock }), null, 'no broad-kraken dir => null');
    // seed AFTER the first (cached-empty) build; within the TTL the cache still returns null
    const refOpenSec = 7_000_000 * 60;
    seedSegments(dataDir, [closedCandle('BTC', refOpenSec, 100, refOpenSec * 1000 + 60_000)]);
    assert.equal(source('BTC', { asOfTs: clock }), null, 'within the TTL the empty index is reused');
    clock += 31_000; // past the TTL: rebuild picks up the seeded segment
    assert.ok(source('BTC', { asOfTs: clock }), 'after the TTL the new data appears');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// PUBLISH-FIX-53: the index is incremental — appended lines are read from the last byte, a torn trailing line waits for
// its rest, a rolled segment's bars survive until retention, an unchanged refresh reads nothing, and the shape is unchanged
test('BKS-3. incremental: appends are picked up from the last byte (no full re-read), torn lines complete on the next append, a rolled segment keeps its bars, the shape and last-write-wins hold', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bks3-')); const dir = path.join(dataDir, 'broad-kraken'); mkdirSync(dir, { recursive: true });
  const T = 1_789_000_020; const seg1 = path.join(dir, 'events-000001.jsonl'); const seg2 = path.join(dir, 'events-000002.jsonl');
  writeFileSync(seg1, [closedCandle('BTC', T, 100, 1), closedCandle('BTC', T + 60, 101, 2)].join('\n') + '\n');
  let clock = 0; const source = createBroadKrakenSeriesSource({ dataDir, ttlMs: 0, now: () => (clock += 1) });
  assert.equal(source('BTC').count, 2); const s0 = source.stats(); assert.equal(s0.fullReads, 1); assert.equal(s0.linesParsed, 2);
  // an unchanged refresh reads nothing
  source('BTC'); const s1 = source.stats(); assert.equal(s1.bytesRead, s0.bytesRead); assert.equal(s1.deltaReads, 0);
  // an append (plus a torn line) is a delta read; the torn line is not parsed yet
  const torn = closedCandle('BTC', T + 180, 103, 4); appendFileSync(seg1, closedCandle('BTC', T + 120, 102, 3) + '\n' + torn.slice(0, 40));
  assert.equal(source('BTC').count, 3); const s2 = source.stats(); assert.equal(s2.deltaReads, 1); assert.equal(s2.linesParsed, 3); assert.equal(s2.fullReads, 1);
  appendFileSync(seg1, torn.slice(40) + '\n'); assert.equal(source('BTC').count, 4, 'the torn line completed'); assert.equal(source('BTC').candles[3][4], 103);
  // last write wins for the same minute, across a new (rolled) segment
  writeFileSync(seg2, closedCandle('BTC', T + 180, 999, 5) + '\n' + closedCandle('ETH', T + 180, 7, 5) + '\n');
  const btc = source('BTC'); assert.equal(btc.candles[3][4], 999); assert.equal(btc.retrievedTsMs, 5); assert.equal(btc.coverageEndSec, T + 240); assert.deepEqual(source.coins(), ['BTC', 'ETH']);
  assert.equal(source.stats().segments, 2);
  // the shape is the one the yardstick consumes
  assert.deepEqual(Object.keys(btc).sort(), ['candles', 'count', 'coverageEndSec', 'filled', 'firstOpenSec', 'index', 'intervalSec', 'lastOpenSec', 'retrievedTsMs', 'symbol', 'trades']); assert.equal(btc.index.get(T + 120), 2); assert.equal(btc.trades.length, btc.candles.length, 'PUBLISH-FIX-83 item 14: one print count per candle (null when the venue did not say)');
  // retention: a bar older than 6 h before the newest is evicted on the next change
  appendFileSync(seg2, closedCandle('BTC', T + 7 * 3600, 5, 6) + '\n'); assert.equal(source('BTC').count, 1, 'only the newest bar survives a 7 h gap');
  rmSync(dataDir, { recursive: true, force: true });
});

test('BKS-6 (PUBLISH-FIX-83 review). a hole of up to five minutes is forward-filled (last close, no volume, no prints) so the yardstick sees a continuous series; a wider hole stays a hole; the print counts age out with their candles', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serpent-bks6-')); const seg = path.join(dir, 'broad-kraken'); mkdirSync(seg, { recursive: true });
  const T = 1_800_000_000; const rec = (coin, openSec, close, trades) => JSON.stringify({ recordType: 'OHLC', quality: 'CONSERVATIVE_CLOSED', market: { canonicalCoin: coin }, periodStartTs: openSec * 1000, periodEndTs: openSec * 1000 + 60_000, receivedTs: openSec * 1000 + 61_000, payload: { open: close, high: close, low: close, close, vwap: close, trades, volumeBase: 1 } });
  const lines = [rec('THIN', T, 10, 3), rec('THIN', T + 60, 11, 2), rec('THIN', T + 300, 12, 4), rec('THIN', T + 360, 13, 1), rec('THIN', T + 1200, 14, 5)]; // holes: 3 minutes (filled), 13 minutes (kept)
  writeFileSync(path.join(seg, 'events-000001.jsonl'), `${lines.join('\n')}\n`);
  const { createBroadKrakenSeriesSource } = await import('../learning/broad-kraken-series.js'); const src = createBroadKrakenSeriesSource({ dataDir: dir, now: () => (T + 1300) * 1000 });
  const s = src('THIN'); assert.ok(s, 'series present');
  assert.deepEqual(s.candles.map((c) => c[0]), [T, T + 60, T + 120, T + 180, T + 240, T + 300, T + 360, T + 1200], 'the three-minute hole is filled, the thirteen-minute hole is not');
  assert.deepEqual(s.candles[2], [T + 120, 11, 11, 11, 11, 0], 'a filled minute carries the last close and no volume'); assert.equal(s.filled, 3); assert.deepEqual(s.trades, [3, 2, null, null, null, 4, 1, 5], 'no print count for a filled minute');
  assert.equal(s.candles.every((c) => c.length === 6), true, 'six numbers, the shape labels.js validates');
  rmSync(dir, { recursive: true, force: true });
});

test('BKS-7 (PUBLISH-FIX-84). the index byte budget is returned when a segment rotates out of the window: after many rotations new segments are still read (before: the budget was spent on segments long gone and every new segment but one per rotation was skipped — the watch read "stale" for every coin, no log line)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serpent-bks7-')); const seg = path.join(dir, 'broad-kraken'); mkdirSync(seg, { recursive: true });
  const T = 1_800_000_000; const rec = (coin, openSec, close) => JSON.stringify({ recordType: 'OHLC', quality: 'CONSERVATIVE_CLOSED', market: { canonicalCoin: coin }, periodStartTs: openSec * 1000, periodEndTs: openSec * 1000 + 60_000, receivedTs: openSec * 1000 + 61_000, payload: { open: close, high: close, low: close, close, volume: 1, trades: 1 } });
  try {
    const { createBroadKrakenSeriesSource } = await import('../learning/broad-kraken-series.js');
    // each segment is ~one candle (~250 bytes); the budget holds about four segments; the window keeps three
    const line = rec('BTC', T, 100); const segBytes = line.length + 1; let clock = T;
    const src = createBroadKrakenSeriesSource({ dataDir: dir, maxSegments: 3, maxBytes: segBytes * 4 + 10, ttlMs: 0, now: () => clock * 1000 });
    let seen = 0;
    for (let i = 1; i <= 30; i += 1) {
      const openSec = T + i * 60; writeFileSync(path.join(seg, `events-${String(i).padStart(6, '0')}.jsonl`), `${rec('BTC', openSec, 100 + i)}\n`);
      if (i > 3) rmSync(path.join(seg, `events-${String(i - 3).padStart(6, '0')}.jsonl`)); // the collector's rotation: only the newest three stay
      clock = openSec + 120; const s = src('BTC'); const last = s?.candles?.[s.candles.length - 1];
      if (last && last[0] === openSec) seen += 1;
    }
    assert.equal(seen, 30, `every new segment was read as it arrived (${seen} of 30) — the budget follows the window`);
    assert.equal(src.stats?.().skippedOverBudget ?? 0, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
