// C-LEDGER drills: summary math over fabricated ledger rows in a sandbox
// data dir. Display math only — nothing here touches trading logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-ledgersum-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { appendJsonl } = await import('../lib/jsonl.js');
const { ledgerSummary } = await import('../ledger/summary.js');
const { loadConfig } = await import('../lib/config.js');

const BASE = loadConfig().paper.baseBalanceUsd;
const fillsFile = path.join(TEST_DATA, 'ledger', 'fills.jsonl');
const exitsFile = path.join(TEST_DATA, 'ledger', 'exits.jsonl');

function trade(id, coin, sizeUsd, netUsd, { ts = '2026-09-01T12:00:00Z', reason = 'TARGET', fees = 0.5 } = {}) {
  appendJsonl(fillsFile, {
    prediction_id: id, ts, coin, side: 'buy', size_usd: sizeUsd,
    base_qty: sizeUsd / 100, avg_price: 100, fee_usd: fees / 2,
  });
  appendJsonl(exitsFile, {
    prediction_id: id, ts, coin, reason_code: reason,
    avg_price: 100 + netUsd / (sizeUsd / 100), proceeds_usd: sizeUsd + netUsd,
    fee_usd: fees / 2, realized_net_usd: netUsd, realized_net_pct: (netUsd / sizeUsd) * 100,
  });
}

test('empty ledger reads as discipline: zeros, nulls, days on watch', () => {
  mkdirSync(path.join(TEST_DATA, 'tape', '2026-09-01'), { recursive: true });
  mkdirSync(path.join(TEST_DATA, 'tape', '2026-09-02'), { recursive: true });
  const s = ledgerSummary();
  assert.equal(s.startingBalance, BASE);
  assert.equal(s.currentBalance, BASE);
  assert.equal(s.totalTrades, 0);
  assert.equal(s.winRatePct, null);
  assert.equal(s.avgWinUsd, null);
  assert.equal(s.largestLossUsd, null);
  assert.equal(s.totalFeesPaid, 0);
  assert.deepEqual(s.perSymbol, {});
  assert.deepEqual(s.lastTrades, []);
  assert.equal(s.daysOnWatch, 2); // two tape session dirs, no invented history
});

test('win rate, averages, largest, fees, per-symbol rollup and today split', () => {
  const now = new Date('2026-09-02T20:00:00Z'); // ET session 2026-09-02
  trade('t1', 'SOL', 50, +5, { ts: '2026-09-01T12:00:00Z' }); // yesterday W
  trade('t2', 'SOL', 50, -2, { ts: '2026-09-01T13:00:00Z' }); // yesterday L
  trade('t3', 'BTC', 100, +10, { ts: '2026-09-02T18:00:00Z' }); // today W
  trade('t4', 'DOGE', 25, -1, { ts: '2026-09-02T19:00:00Z', reason: 'TIME_STOP' }); // today L
  const s = ledgerSummary(now);

  assert.equal(s.totalTrades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.winRatePct, 50);
  assert.equal(s.netPnl.usd, 12);
  assert.equal(s.currentBalance, BASE + 12);
  assert.ok(Math.abs(s.netPnl.pct - (12 / BASE) * 100) < 1e-9);
  assert.equal(s.todayPnl.usd, 9); // t3 + t4 only
  assert.equal(s.avgWinUsd, 7.5); // (5+10)/2
  assert.equal(s.avgLossUsd, -1.5); // (-2-1)/2
  assert.equal(s.largestWinUsd, 10);
  assert.equal(s.largestLossUsd, -2);
  assert.equal(s.totalFeesPaid, 2); // 4 trades x $0.50
  assert.deepEqual(s.perSymbol.SOL, { trades: 2, netUsd: 3 });
  assert.deepEqual(s.perSymbol.BTC, { trades: 1, netUsd: 10 });
  assert.deepEqual(s.perSymbol.DOGE, { trades: 1, netUsd: -1 });

  const last = s.lastTrades;
  assert.equal(last.length, 4);
  assert.equal(last[0].prediction_id, 't4'); // newest first
  assert.equal(last[0].result, 'L');
  assert.equal(last[0].exitReason, 'TIME_STOP');
  assert.equal(last[0].side, 'LONG');
  assert.ok(/^\d{2}\/\d{2} \d{2}:\d{2}$/.test(last[0].etTime));
});

test('open position without a live tape shows null mark/unrealized, never a guess', () => {
  appendJsonl(fillsFile, {
    prediction_id: 'open1', ts: '2026-09-02T19:30:00Z', coin: 'ETH', side: 'buy',
    size_usd: 40, base_qty: 0.01, avg_price: 4000, fee_usd: 0.32,
  });
  const s = ledgerSummary(new Date('2026-09-02T20:00:00Z'));
  assert.equal(s.openPositions.length, 1);
  assert.equal(s.openPositions[0].symbol, 'ETH');
  assert.equal(s.openPositions[0].mark, null);
  assert.equal(s.openPositions[0].unrealizedUsd, null);
  assert.equal(s.totalTrades, 4); // open position is not a closed trade
});

test('a data dir that does not exist at all yields the valid empty-state summary, never an error', () => {
  const saved = process.env.COBRA_DATA_DIR;
  process.env.COBRA_DATA_DIR = path.join(TEST_DATA, 'never-created', 'nested', 'deploy-disk');
  try {
    const s = ledgerSummary();
    assert.equal(s.startingBalance, BASE);
    assert.equal(s.currentBalance, BASE);
    assert.equal(s.totalTrades, 0);
    assert.equal(s.winRatePct, null);
    assert.deepEqual(s.lastTrades, []);
    assert.deepEqual(s.openPositions, []);
    assert.equal(s.daysOnWatch, 0);
    // read path must not have created anything on a disk it doesn't own
    assert.equal(existsSync(path.join(TEST_DATA, 'never-created')), false);
  } finally {
    process.env.COBRA_DATA_DIR = saved;
  }
});

test('empty-but-present ledger files (zero-byte) also yield the empty state', () => {
  const saved = process.env.COBRA_DATA_DIR;
  const dir = path.join(TEST_DATA, 'empty-files');
  process.env.COBRA_DATA_DIR = dir;
  try {
    mkdirSync(path.join(dir, 'ledger'), { recursive: true });
    writeFileSync(path.join(dir, 'ledger', 'fills.jsonl'), '');
    writeFileSync(path.join(dir, 'ledger', 'exits.jsonl'), '');
    writeFileSync(path.join(dir, 'ledger', 'predictions.jsonl'), '\n'); // torn/blank lines tolerated
    const s = ledgerSummary();
    assert.equal(s.totalTrades, 0);
    assert.equal(s.currentBalance, BASE);
    assert.equal(s.pendingPredictions, 0);
  } finally {
    process.env.COBRA_DATA_DIR = saved;
  }
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
