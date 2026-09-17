// PUBLISH-FIX-17 (2026-09-17, independent review F4) — the paper adapter's displayed-liquidity state is bounded by what
// carries safety information (consumed quantity, continuity-loss marks), never by the history of distinct prices shown.
// The review's witness: add then remove 10,000 distinct price levels with zero orders => 10,000 retained map entries and
// 10,000 checkpoint entries. Now: zero and zero. The generation / consumed-liquidity laws and restart safety are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { adapterEventError } from '../execution/adapter-contract.js';
import { fakeClock, SPEC, TAKER_FEE, T0 } from './helpers/judge.js';

const intent = (over = {}) => ({ intentId: 'i1', orderId: 'o1', clientOrderId: 'clord000000000001', reservationId: 'r1', positionId: 'p1', kind: 'ENTRY', side: 'buy', pair: 'XBT/USD', qty: '0.001', limitPrice: '100000', orderType: 'limit', timeInForce: 'IOC', protection: { ordertype: 'stop-loss', trigger: 'last', price: '99000' }, deadlineTs: T0 + 3000, feeDigest: TAKER_FEE.feeDigest, specDigest: SPEC.specDigest, snapshotDigest: null, createdTs: T0, ...over });
function paperFixture({ clock = fakeClock(), restore = null } = {}) {
  const feed = createExecutionFeed({ clock: clock.now }); feed.admit('XBT/USD', { priority: 'PENDING', reason: 'test' }); feed.onConnect(clock.now()); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  const adapter = createPaperAdapter({ accountId: 'paper-t', clock: clock.now, feed, fee: TAKER_FEE, specOf: () => SPEC, restore }); const events = []; adapter.subscribe((e) => { assert.equal(adapterEventError(e), null); events.push(e); });
  const book = (type, asks, bids, ts = clock.now()) => { feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), timestamp: new Date(ts).toISOString() }] }), ts); };
  return { clock, feed, adapter, events, book };
}

test('F4 witness: 10,000 distinct price levels added and removed with no orders leave NO map entries and an EMPTY checkpoint', () => {
  const { clock, adapter, book } = paperFixture();
  book('snapshot', [[100000.0, 1]], [[99999.0, 1]]);
  for (let i = 0; i < 10_000; i += 1) { clock.advance(1); book('update', [[100001.0 + i * 0.1, 1]], []); }
  assert.equal(adapter.status().depletionLevels, 0, 'a level nothing was taken from carries no state');
  for (let i = 0; i < 10_000; i += 1) { clock.advance(1); book('update', [[100001.0 + i * 0.1, 0]], []); }
  assert.equal(adapter.status().depletionLevels, 0); assert.deepEqual(adapter.checkpoint().levels, []);
  // availability answers exactly as before for a never-consumed level, with or without an entry
  assert.equal(adapter.availableAt('XBT/USD', 'asks', '100500', '3'), '3');
});

test('F4: a consumed level keeps its tombstone through removal (generation law intact), resets on a new positive level, and a restart never duplicates usable liquidity', async () => {
  const f = paperFixture(); const { clock, adapter, book } = f; const L = 100000.0;
  book('snapshot', [[L, 10]], [[99999.0, 1]]);
  await adapter.submitEntryWithProtection({ intent: intent({ qty: '6', limitPrice: '100000' }), spec: SPEC }); clock.advance(300); book('update', [[L, 10]], []);
  assert.equal(adapter.availableAt('XBT/USD', 'asks', '100000', '10'), '4'); assert.equal(adapter.status().depletionLevels, 1);
  // 500 unrelated levels come and go: still one entry
  for (let i = 0; i < 500; i += 1) { clock.advance(1); book('update', [[100002.0 + i, 2]], []); clock.advance(1); book('update', [[100002.0 + i, 0]], []); }
  assert.equal(adapter.status().depletionLevels, 1);
  // removal of the CONSUMED level keeps a tombstone (safety information), so a re-add is a new generation, never a refund in place
  clock.advance(10); book('update', [[L, 0]], []); assert.equal(adapter.status().depletionLevels, 1); assert.equal(adapter.depletionOf('XBT/USD', 'asks', '100000').tombstone, true);
  const cp = adapter.checkpoint(); assert.equal(cp.levels.length, 1, 'the checkpoint carries only the safety-relevant level');
  const g = paperFixture({ restore: cp }); g.book('snapshot', [[L, 10]], [[99999.0, 1]]);
  assert.equal(g.adapter.availableAt('XBT/USD', 'asks', '100000', '10'), '4', 'a restart from the checkpoint conserves the consumed quantity of the tombstoned level: no duplicated usable liquidity');
  g.clock.advance(10); g.book('update', [[L, 0]], []); g.clock.advance(10); g.book('update', [[L, 7]], []);
  assert.equal(g.adapter.availableAt('XBT/USD', 'asks', '100000', '7'), '7', 'explicit removal then a newly observed positive level is the new generation'); assert.equal(g.adapter.depletionOf('XBT/USD', 'asks', '100000').generation, 2);
  // the reset level is dropped at its next removal: nothing left to carry
  g.clock.advance(10); g.book('update', [[L, 0]], []); assert.equal(g.adapter.status().depletionLevels, 0);
  // continuity loss still marks consumed levels uncertain, and an uncertain level is retained until it is reset
  clock.advance(10); book('update', [[L, 7]], []); await adapter.submitEntryWithProtection({ intent: intent({ qty: '2', limitPrice: '100000', clientOrderId: 'clord000000000002', orderId: 'o2', positionId: 'p2', intentId: 'i2', reservationId: 'r2' }), spec: SPEC }); clock.advance(300); book('update', [[L, 7]], []);
  clock.advance(10); f.feed.onDisconnect(clock.now()); f.feed.onConnect(clock.now()); book('snapshot', [[L, 7]], [[99999.0, 1]]);
  assert.equal(adapter.availableAt('XBT/USD', 'asks', '100000', '7'), '0'); assert.equal(adapter.depletionOf('XBT/USD', 'asks', '100000').uncertain, true);
  clock.advance(10); book('update', [[L, 0]], []); assert.equal(adapter.status().depletionLevels, 1, 'an uncertain level is safety information: kept as a tombstone');
});
