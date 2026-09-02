// Unit drills: the parts of the skeleton that must never be wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate all persistence into a throwaway data dir BEFORE importing modules.
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-test-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { crc32 } = await import('../lib/crc32.js');
const { OrderBook, decimalsOf } = await import('../tape/book.js');
const { bookFeatures, TradeFlow } = await import('../tape/features.js');
const { walkAsksForUsd, walkBidsForQty, priceRoundTrip } = await import('../cost/model.js');
const { lockLevelForPnlPct, injectSimulatedPnlPct, clearSimulatedPnl, dailyLockStatus } = await import(
  '../state/locks.js'
);
const { kill, cage, veto, isVetoed, clearLatches, readControls } = await import('../state/controls.js');
const { getEngineState, STATES } = await import('../state/machine.js');
const { recordPrediction, simulateEntry, PriceBlindViolation } = await import('../ledger/ledger.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

test('crc32 matches the IEEE reference vector', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32(''), 0);
});

test('decimalsOf derives precision from increments', () => {
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(1e-8), 8);
  assert.equal(decimalsOf(1), 0);
  assert.equal(decimalsOf(0), null);
});

test('order book applies snapshots, updates, deletions and truncation', () => {
  const book = new OrderBook('BTC/USD', 3);
  book.applySnapshot({
    bids: [
      { price: 100, qty: 1 },
      { price: 99, qty: 2 },
    ],
    asks: [
      { price: 101, qty: 1 },
      { price: 102, qty: 2 },
    ],
  });
  assert.equal(book.bestBid().price, 100);
  assert.equal(book.bestAsk().price, 101);
  book.applyUpdate({ bids: [{ price: 100, qty: 0 }, { price: 98, qty: 5 }], asks: [] });
  assert.equal(book.bestBid().price, 99);
  // Truncation keeps only `depth` best levels.
  book.applyUpdate({ bids: [{ price: 97, qty: 1 }, { price: 96, qty: 1 }], asks: [] });
  assert.equal(book.sortedBids().length, 3);
  assert.equal(book.sortedBids().at(-1).price, 97);
});

test('checksum verification detects a drifted book', () => {
  const book = new OrderBook('BTC/USD', 10);
  book.setPrecision(1, 8);
  book.applySnapshot({
    bids: [{ price: 100.5, qty: 1.5 }],
    asks: [{ price: 101.5, qty: 0.25 }],
  });
  const good = book.checksum();
  const okCheck = book.applyUpdate({ bids: [], asks: [], checksum: good });
  assert.equal(okCheck.ok, true);
  const badCheck = book.applyUpdate({ bids: [{ price: 99.9, qty: 1 }], asks: [], checksum: good });
  assert.equal(badCheck.ok, false);
});

test('checksum digest format: decimal stripped, leading zeros stripped', () => {
  const book = new OrderBook('DOGE/USD', 10);
  book.setPrecision(5, 8);
  book.applySnapshot({ bids: [{ price: 0.1, qty: 2 }], asks: [{ price: 0.2, qty: 1 }] });
  // ask 0.20000 -> "20000", qty 1.00000000 -> "100000000"; bid 0.10000 -> "10000", qty 2 -> "200000000"
  assert.equal(book.checksum(), crc32('2000010000000010000200000000'));
});

test('book features: spread bps and OBI', () => {
  const book = new OrderBook('ETH/USD', 25);
  book.applySnapshot({
    bids: [{ price: 999, qty: 10 }],
    asks: [{ price: 1001, qty: 5 }],
  });
  const f = bookFeatures(book);
  assert.equal(f.mid, 1000);
  assert.ok(Math.abs(f.spreadBps - 20) < 1e-9);
  // bid notional 9990 vs ask 5005 -> positive imbalance
  assert.ok(f.obi.top > 0);
});

test('trade flow imbalance and CVD', () => {
  const flow = new TradeFlow();
  const now = Date.now();
  flow.add({ ts: now - 1000, side: 'buy', qty: 3, price: 10 });
  flow.add({ ts: now - 500, side: 'sell', qty: 1, price: 10 });
  assert.equal(flow.cvd, 2);
  assert.ok(Math.abs(flow.imbalanceOver(15_000, now) - 0.5) < 1e-9);
  assert.equal(flow.imbalanceOver(15_000, now + 60_000), null); // empty window -> null, never invented
});

test('walking asks spends exactly the requested USD', () => {
  const asks = [
    { price: 100, qty: 1 },
    { price: 101, qty: 1 },
  ];
  const walk = walkAsksForUsd(asks, 150.5);
  assert.equal(walk.exhausted, false);
  assert.ok(Math.abs(walk.baseQty - (1 + 50.5 / 101)) < 1e-12);
  const tooBig = walkAsksForUsd(asks, 1000);
  assert.equal(tooBig.exhausted, true);
});

test('walking bids sells exactly the requested qty', () => {
  const bids = [
    { price: 100, qty: 1 },
    { price: 99, qty: 1 },
  ];
  const walk = walkBidsForQty(bids, 1.5);
  assert.equal(walk.exhausted, false);
  assert.ok(Math.abs(walk.proceedsUsd - (100 + 49.5)) < 1e-12);
  assert.equal(walkBidsForQty(bids, 5).exhausted, true);
});

test('round trip friction is positive and includes both fees', () => {
  const book = {
    bids: [{ price: 99, qty: 100 }],
    asks: [{ price: 101, qty: 100 }],
  };
  const fees = { maker: 0.004, taker: 0.008 };
  const r = priceRoundTrip(book, 1000, fees);
  assert.equal(r.status, 'OK');
  assert.ok(r.estimatedRoundTripFrictionUsd > 0);
  assert.ok(r.trueEntryCostUsd > 1000);
  assert.ok(r.trueExitValueUsd < 1000);
  assert.ok(r.breakEvenMovePct > 0);
  assert.equal(r.makerPath.flag, 'OPTIMISTIC');
  const thin = priceRoundTrip({ bids: book.bids, asks: [{ price: 101, qty: 0.001 }] }, 1000, fees);
  assert.equal(thin.status, 'UNAVAILABLE_DEPTH');
});

test('lock thresholds: 5/8/11', () => {
  const locks = { selectivePct: 5, protectPct: 8, hardPct: 11 };
  assert.equal(lockLevelForPnlPct(0, locks), 'NONE');
  assert.equal(lockLevelForPnlPct(4.99, locks), 'NONE');
  assert.equal(lockLevelForPnlPct(5, locks), 'SELECTIVE');
  assert.equal(lockLevelForPnlPct(7.99, locks), 'SELECTIVE');
  assert.equal(lockLevelForPnlPct(8, locks), 'PROTECT');
  assert.equal(lockLevelForPnlPct(11, locks), 'HARD_LOCK');
  assert.equal(lockLevelForPnlPct(-3, locks), 'NONE'); // losses don't lock in C-1
});

test('simulated P&L injection trips each lock and KILL forces RETREAT', () => {
  const config = loadConfig();

  injectSimulatedPnlPct(6);
  assert.equal(dailyLockStatus().level, 'SELECTIVE');
  assert.equal(dailyLockStatus().strikes_allowed, true);

  injectSimulatedPnlPct(9);
  assert.equal(dailyLockStatus().level, 'PROTECT');
  assert.equal(dailyLockStatus().strikes_allowed, false);

  injectSimulatedPnlPct(12);
  assert.equal(dailyLockStatus().level, 'HARD_LOCK');
  assert.equal(getEngineState(config).state, STATES.RETREAT); // hard lock -> RETREAT

  clearSimulatedPnl();
  assert.equal(getEngineState(config).state, STATES.COILED);

  kill();
  assert.equal(getEngineState(config).state, STATES.RETREAT);
  clearLatches();
  assert.equal(getEngineState(config).state, STATES.COILED);

  cage();
  assert.equal(readControls().cage.active, true);
  clearLatches();

  veto('some-prediction-id');
  assert.equal(isVetoed('some-prediction-id'), true);
  assert.equal(isVetoed('another-id'), false);
});

test('price-blind gate: no persisted prediction, no price fetch', () => {
  // With no prediction on disk the entry path must refuse at the gate —
  // PriceBlindViolation, not a tape/availability error (which would prove the
  // price read was attempted first).
  assert.throws(() => simulateEntry('00000000-0000-0000-0000-000000000000'), PriceBlindViolation);
});

test('prediction persists price-blind, then entry requires live tape', () => {
  const row = recordPrediction({
    coin: 'BTC',
    thesis: 'unit drill',
    horizonMin: 30,
    predictedNetMovePct: 1,
    sizeUsd: 100,
  });
  assert.ok(row.prediction_id);
  assert.ok(row.timestamp_prediction_persisted);
  // Prediction exists on disk, but there is no live tape in the test sandbox:
  // now the failure must be an availability refusal, not a price-blind one.
  assert.throws(() => simulateEntry(row.prediction_id), /UNAVAILABLE — NO TRADE/);
});

test('thesis is mandatory', () => {
  assert.throws(() => recordPrediction({ coin: 'BTC', thesis: '  ', sizeUsd: 100 }));
  assert.throws(() => recordPrediction({ coin: 'SHIB', thesis: 'nope', sizeUsd: 100 }), /not in universe/);
});
