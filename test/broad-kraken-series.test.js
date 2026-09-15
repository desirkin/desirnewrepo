// BROAD-KRAKEN 1m SERIES SOURCE (Ticket 3 step 3, 2026-09-15). Reads the collector's rolling segments into the
// label-series shape the yardstick consumes. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
