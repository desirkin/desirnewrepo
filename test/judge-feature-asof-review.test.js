// Point-in-time feature boundaries: event time selects the market window while
// receipt time and feed epoch select what was actually knowable at that time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_MS,
  createFlowTracker,
  flowImbalance,
  relativeVolume60,
} from '../judge/features.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createBarHistory } from '../judge/history.js';

const T = Date.UTC(2026, 8, 13, 12);

function trade({
  eventTs,
  receiptTs = eventTs,
  feedEpoch = 1,
  nativeTradeId = `t-${eventTs}-${receiptTs}-${feedEpoch}`,
  side = 'buy',
  quoteNotional = '100',
  snapshot = false,
} = {}) {
  return {
    tradeVersion: 'execution-trade-1',
    symbol: 'XBT/USD',
    canonicalCoin: 'BTC',
    feedEpoch,
    receiptSequence: Math.max(1, Math.floor(receiptTs - (T - 30 * BAR_MS))),
    nativeTradeId,
    side,
    price: '1',
    qty: quoteNotional,
    quoteNotional,
    eventTs,
    receiptTs,
    fromSubscriptionSnapshot: snapshot,
    orderType: 'market',
  };
}

test('control: subscription snapshots remain excluded from flow', () => {
  const result = flowImbalance([
    trade({ eventTs: T - 1_000, receiptTs: T - 500, snapshot: true }),
  ], T - 15_000, T);
  assert.equal(result.count, 0);
  assert.equal(result.state, 'UNKNOWN');
});

test('event-time window excludes a row received after its as-of end', () => {
  const result = flowImbalance([
    trade({ eventTs: T - 100, receiptTs: T + 100 }),
  ], T - 15_000, T);
  assert.equal(result.count, 0, 'the trade was not known at trigger T');
  assert.equal(result.state, 'UNKNOWN');
});

test('direct flow batch fails closed when a relevant row has event-after-receipt chronology', () => {
  const result = flowImbalance([
    trade({ eventTs: T - 100, receiptTs: T - 90, side: 'buy', nativeTradeId: 'valid-buy' }),
    trade({ eventTs: T - 500, receiptTs: T - 600, side: 'sell', nativeTradeId: 'invalid-clock' }),
  ], T - 15_000, T);
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.reason, 'AS_OF_OR_EPOCH_INVALID');
  assert.equal(result.count, 0, 'a valid subset is not promoted when its relevant batch is malformed');
});

test('actual feed delivering an old-event trade after trigger T cannot backfill [T-15s,T)', () => {
  const feed = createExecutionFeed({ clock: () => T + 100 });
  const flow = createFlowTracker();
  feed.subscribe((event) => { if (event.kind === 'TRADE') flow.add(event.trade); });
  feed.admit('XBT/USD', { priority: 'CANDIDATE' });
  feed.onConnect(T - 5_000);
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), T - 4_000);
  feed.ingest(JSON.stringify({
    channel: 'trade',
    type: 'update',
    data: [{ symbol: 'XBT/USD', side: 'buy', price: '1', qty: '100', ord_type: 'market', trade_id: 7, timestamp: new Date(T - 100).toISOString() }],
  }), T + 100);
  const atTrigger = flow.fi(T - 15_000, T);
  assert.equal(atTrigger.count, 0, 'receipt T+100 cannot revise a fact frozen at T');
});

function rvRows(D) {
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = [trade({ eventTs: E - 30_000, receiptTs: E - 29_900, nativeTradeId: 'numerator' })];
  for (let k = 1; k <= 20; k += 1) {
    const eventTs = E - (k + 1) * BAR_MS + 1_000;
    rows.push(trade({ eventTs, receiptTs: eventTs + 100, nativeTradeId: `baseline-${k}` }));
  }
  return rows;
}

test('RV60 excludes future-receipt rows even when their event time is in a completed minute', () => {
  const D = T + 5_000;
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = rvRows(D);
  rows.push(trade({ eventTs: E - 20_000, receiptTs: D + 1, nativeTradeId: 'future-known', quoteNotional: '900' }));
  const coverage = { continuous: true, epoch: 1, startTs: E - 21 * BAR_MS, endTs: D, gapTs: null };
  const result = relativeVolume60(rows, D, coverage);
  assert.equal(result.rv60, 1, 'future-known numerator notional cannot inflate the point-in-time ratio');
});

test('RV60 admits a delayed print received after its event window but by decision D', () => {
  const D = T + 5_000;
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = rvRows(D);
  rows.push(trade({ eventTs: E - 20_000, receiptTs: E + 1_000, nativeTradeId: 'late-but-known', quoteNotional: '900' }));
  const coverage = { continuous: true, epoch: 1, startTs: E - 21 * BAR_MS, endTs: D, gapTs: null };
  assert.equal(relativeVolume60(rows, D, coverage).rv60, 10, 'decision-time as-of applies to every RV window');
});

test('RV60 uses decision D as-of for delayed-but-known prints in baseline windows too', () => {
  const D = T + 5_000;
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = rvRows(D);
  for (let k = 1; k <= 11; k += 1) rows.push(trade({
    eventTs: E - (k + 1) * BAR_MS + 2_000,
    receiptTs: E - k * BAR_MS + 1_000,
    nativeTradeId: `delayed-baseline-${k}`,
    quoteNotional: '900',
  }));
  const coverage = { continuous: true, epoch: 1, startTs: E - 21 * BAR_MS, endTs: D, gapTs: null };
  assert.equal(relativeVolume60(rows, D, coverage).rv60, 0.1, 'late prints known by D remain legitimate baseline evidence');
});

test('RV60 malformed clocks, collections and coverage fail closed without throwing', () => {
  const D = T + 5_000;
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = rvRows(D);
  const valid = { continuous: true, epoch: 1, startTs: E - 21 * BAR_MS, endTs: D, gapTs: null };
  for (const [trades, decisionTs, coverage, reason] of [
    [null, D, valid, 'INPUT_INVALID'],
    [rows, Number.NaN, valid, 'INPUT_INVALID'],
    [rows, -1, valid, 'INPUT_INVALID'],
    [rows, D + 0.5, valid, 'INPUT_INVALID'],
    [rows, D, undefined, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, startTs: undefined }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, endTs: Number.NaN }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, startTs: -1 }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, startTs: D, endTs: D - 1 }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, endTs: D + 1 }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, gapTs: -1 }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, gapTs: 'old' }, 'COVERAGE_INCOMPLETE'],
    [rows, D, { ...valid, gapTs: D - 1 }, 'COVERAGE_INCOMPLETE'],
  ]) assert.equal(relativeVolume60(trades, decisionTs, coverage).reason, reason);

  const malformed = [...rows, trade({ eventTs: E - 20_000, receiptTs: E - 21_000, nativeTradeId: 'invalid-rv-clock' })];
  const invalidBatch = relativeVolume60(malformed, D, valid);
  assert.equal(invalidBatch.state, 'UNKNOWN');
  assert.equal(invalidBatch.reason, 'INPUT_INVALID');
});

test('actual feed recovers RV only after 21 complete post-gap minutes and retains the historical gap diagnostic', () => {
  const gapTs = T - 21 * BAR_MS;
  const feed = createExecutionFeed({ clock: () => T + 5_000, limits: { impairedAfterMs: 90_000, criticalAfterMs: 180_000 } });
  const tracker = createFlowTracker();
  feed.subscribe((event) => { if (event.kind === 'TRADE') tracker.add(event.trade); });
  feed.admit('XBT/USD', { priority: 'CANDIDATE' });
  feed.onConnect(gapTs - 200_001);
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), gapTs - 200_000);
  feed.ingest(JSON.stringify({ channel: 'heartbeat' }), gapTs);

  const ingestMinute = (minute) => {
    const ts = gapTs + minute * BAR_MS + 1_000;
    feed.ingest(JSON.stringify({
      channel: 'trade', type: 'update',
      data: [{ symbol: 'XBT/USD', side: 'buy', price: '1', qty: '100', ord_type: 'market', trade_id: minute + 1, timestamp: new Date(ts).toISOString() }],
    }), ts);
  };
  for (let minute = 0; minute < 20; minute += 1) ingestMinute(minute);
  const beforeD = gapTs + 20 * BAR_MS + 5_000;
  assert.equal(tracker.rv60(beforeD, feed.coverage('XBT/USD', beforeD)).reason, 'COVERAGE_INCOMPLETE');

  ingestMinute(20);
  const after = tracker.rv60(T + 5_000, feed.coverage('XBT/USD', T + 5_000));
  assert.equal(after.state, 'KNOWN');
  assert.equal(after.rv60, 1);
  assert.equal(feed.coverage('XBT/USD', T + 5_000).gapTs, gapTs, 'historical gap remains visible at the continuous-coverage start');
  assert.equal(feed.status().counters.coverageGaps, 1, 'recovery does not erase the gap counter');
});

test('RV60 does not mix a prior feed epoch into current coverage', () => {
  const D = T + 5_000;
  const E = Math.floor(D / BAR_MS) * BAR_MS;
  const rows = rvRows(D);
  rows.push(trade({ eventTs: E - 20_000, receiptTs: E - 19_900, feedEpoch: 0, nativeTradeId: 'prior-epoch', quoteNotional: '900' }));
  const coverage = { continuous: true, epoch: 1, startTs: E - 21 * BAR_MS, endTs: D, gapTs: null };
  assert.equal(relativeVolume60(rows, D, coverage).rv60, 1);
});

test('incremental flow queries do not retain rows from a prior feed epoch', () => {
  const tracker = createFlowTracker();
  tracker.add(trade({ eventTs: T - 1_000, feedEpoch: 1, nativeTradeId: 'old', side: 'buy' }));
  tracker.add(trade({ eventTs: T, feedEpoch: 2, nativeTradeId: 'new', side: 'sell' }));
  const current = tracker.fi(T - 5_000, T + 1_000);
  assert.equal(current.count, 1, 'only the current tracker epoch is eligible');
  assert.equal(current.fi, -1);
  assert.equal(tracker.add(trade({ eventTs: T + 1, receiptTs: T + 1, feedEpoch: 1, nativeTradeId: 'late-old-epoch' })), false, 'an older epoch cannot switch the tracker back');
});

test('bar history lookup does not expose rows whose retrieval receipt is after query time', () => {
  const history = createBarHistory({ clock: () => T });
  const rows = [];
  for (let k = 61; k >= 1; k -= 1) {
    const open = T - k * BAR_MS;
    rows.push([open / 1_000, '100', '101', '99', '100', '100', '1', 1]);
  }
  history.ingestRows('XBT/USD', rows, T + 1_000, T);
  assert.equal(history.bars('XBT/USD', T) === null, true, 'the REST rows were not known at T');
  assert.equal(history.bars('XBT/USD', -1), null);
  assert.equal(history.bars('XBT/USD', Number.NaN), null);
  assert.equal(history.bars('XBT/USD', T + 0.5), null);
});

test('tracker rejects event-after-receipt chronology before it reaches any query', () => {
  const tracker = createFlowTracker();
  assert.equal(tracker.add(trade({ eventTs: T + 1, receiptTs: T, nativeTradeId: 'future-event' })), false);
  assert.equal(tracker.add(trade({ eventTs: -1, receiptTs: 0, nativeTradeId: 'negative-event' })), false);
  assert.equal(tracker.add(trade({ eventTs: 0, receiptTs: -1, nativeTradeId: 'negative-receipt' })), false);
  assert.equal(tracker.status().trades, 0);
});
