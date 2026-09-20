// PUBLISH-FIX-83 — full review items 2, 3, 4 and 9 (the entry path): the intent deadline restarts at the durable attempt; an
// unfilled terminal entry never leaves a SHELL holding the slot; an adapter burst commits as ONE append mapped against the
// state the burst itself produces; an ended pin steps the feed admission down instead of erasing its trackers, and a warming
// preparation tenant is never preempted by a newer nomination. Every venue is a local double; nothing here reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createExecutionFeed } from '../execution/feed.js';
import { applyEvent, slotsUsed, availableCash } from '../execution/reducer.js';
import { selectPreparation } from '../judge/readiness.js';
import { paperAccount, fakeClock, SPEC, TAKER_FEE, T0 } from './helpers/judge.js';

// a venue double whose entry outcome is scripted and whose subscriber can be driven with a synchronous burst
function venue({ entry = 'ACKNOWLEDGED', reason = null } = {}) {
  const calls = { entries: [] }; let sub = null;
  return { kind: 'PAPER', calls, subscribe(fn) { sub = fn; }, emit(list) { for (const ae of list) sub?.(ae); }, async drain() { return {}; },
    async submitEntryWithProtection({ intent }) { calls.entries.push(intent.orderId); return entry === 'REJECTED' ? { outcome: 'REJECTED', nativeOrderId: null, reason: reason ?? 'scripted reject', guaranteesNoAcceptance: true } : { outcome: 'ACKNOWLEDGED', nativeOrderId: `nat-${intent.orderId}`, reason: null, guaranteesNoAcceptance: false }; },
    async closeResidual() { return { outcome: 'ACKNOWLEDGED', nativeOrderId: 'sell-x', reason: null, guaranteesNoAcceptance: false }; }, async cancelOwnedOrder() { return { outcome: 'CANCELLED', reason: null }; }, async reconcile() { return { outcome: 'COMPLETE', unmatched: 0, pageIncomplete: false }; }, async amendProtection() { return { outcome: 'FAILED' }; }, status() { return { stops: [], counters: {} }; } };
}
async function rig({ accountId, adapter, feed = null, clock = fakeClock() }) {
  const r = await paperAccount({ accountId, clock }); const { F } = r;
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
  const d = createDispatcher({ accountId: r.accountId, journal: r.journal, writer: r.writer, adapter, clock: r.clock, specOf: () => SPEC, feeOf: () => TAKER_FEE, feed }); await d.load();
  return { ...r, d };
}
const bookInto = (feed, clock) => feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: [{ price: '100010.0', qty: '5' }], bids: [{ price: '99990.0', qty: '5' }] }] }), clock.now());
const freshFeed = (clock, { book = true } = {}) => { const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now()); feed.admit('XBT/USD', { priority: 'PENDING', reason: 'test' }); if (book) bookInto(feed, clock); return feed; };

test('FIX83-2. the intent deadline restarts at the durable dispatch attempt (bounded by the intent window); an attempt clock cannot stretch it', async () => {
  const r = await paperAccount({ accountId: 'fix83-2' }); const { F, clock } = r; let s = await r.state();
  const base = [F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]; for (const e of base) s = applyEvent(s, e);
  const o0 = s.orders.o1; const window = o0.deadlineTs - o0.createdTs; assert.equal(window, 3000);
  clock.advance(2500); // the queue wait ate most of the window: the old law would have left 500 ms for two commits and a send
  const t0 = clock.now(); s = applyEvent(s, F.ev('DISPATCH_ATTEMPTED', { orderId: 'o1', attemptId: 'att-o1', adapter: 'PAPER', ts: t0, deadlineTs: t0 + window }));
  assert.equal(s.orders.o1.deadlineTs, t0 + window, 'the deadline is rebased to attempt + window'); assert.equal(s.orders.o1.deadlineRebasedFrom, o0.deadlineTs);
  // a deadline beyond attempt + window is NOT adopted (the window is the intent's own promise, never widened)
  let s2 = await r.state(); for (const e of base) s2 = applyEvent(s2, e); s2 = applyEvent(s2, F.ev('DISPATCH_ATTEMPTED', { orderId: 'o1', attemptId: 'att-o1', adapter: 'PAPER', ts: t0, deadlineTs: t0 + window + 1 }));
  assert.equal(s2.orders.o1.deadlineTs, o0.deadlineTs, 'an over-wide rebase is ignored'); assert.equal(s2.orders.o1.deadlineRebasedFrom, undefined);
  // and the dispatcher stamps it: an entry dispatched 2.5 s after its intent still carries a 3 s deadline from the attempt
  const clock2 = fakeClock(); const ad = venue(); const feed2 = freshFeed(clock2); const rr = await rig({ accountId: 'fix83-2b', adapter: ad, feed: feed2, clock: clock2 }); clock2.advance(2500); bookInto(feed2, clock2);
  const res = await rr.d.dispatchEntry('o1'); assert.equal(res.outcome, 'ACKNOWLEDGED'); const o = rr.d.state().orders.o1; assert.equal(o.deadlineTs, clock2.now() + 3000); assert.equal(o.deadlineRebasedFrom, T0 + 3000);
});

test('FIX83-3. an entry that ends terminal with nothing filled closes its SHELL flat and releases the pin — from the venue REJECTED, the pre-send refusal and the unfilled EXPIRED', async () => {
  // (a) venue REJECTED with a no-acceptance guarantee
  const c1 = fakeClock(); const a1 = venue({ entry: 'REJECTED', reason: 'EOrder:Insufficient funds' }); const r1 = await rig({ accountId: 'fix83-3a', adapter: a1, feed: freshFeed(c1), clock: c1 });
  const res = await r1.d.dispatchEntry('o1'); assert.equal(res.outcome, 'REJECTED'); let s = r1.d.state();
  assert.equal(s.orders.o1.state, 'REJECTED'); assert.equal(s.positions.p1.state, 'FLAT', JSON.stringify(s.positions.p1)); assert.equal(s.reservations.r1.state, 'RELEASED'); assert.equal(slotsUsed(s), 0, 'the slot is free'); assert.equal(s.pins?.['XBT/USD'] ?? null, null, 'the pin is released'); assert.equal(availableCash(s), s.cash);
  assert.match(s.positions.p1.exit?.primaryReason ?? s.positions.p1.closeReason ?? '', /entry unfilled/);
  // (b) the pre-send authority refusal (no fresh quote)
  const c2 = fakeClock(); const a2 = venue(); const r2 = await rig({ accountId: 'fix83-3b', adapter: a2, feed: freshFeed(c2, { book: false }), clock: c2 });
  const res2 = await r2.d.dispatchEntry('o1'); assert.equal(res2.outcome, 'REJECTED', JSON.stringify(res2)); assert.match(res2.reason, /AUTHORITY_REFUSED/); s = r2.d.state(); assert.equal(s.orders.o1.state, 'CANCELLED'); assert.equal(s.positions.p1.state, 'FLAT'); assert.equal(slotsUsed(s), 0); assert.equal(a2.calls.entries.length, 0);
  // (c) ACKNOWLEDGED then EXPIRED with nothing filled, reported by the adapter
  const c3 = fakeClock(); const a3 = venue(); const r3 = await rig({ accountId: 'fix83-3c', adapter: a3, feed: freshFeed(c3), clock: c3 });
  await r3.d.dispatchEntry('o1'); assert.equal(r3.d.state().orders.o1.state, 'ACKNOWLEDGED'); c3.advance(3100);
  a3.emit([{ type: 'ORDER_STATE', payload: { orderId: 'o1', state: 'EXPIRED', nativeOrderId: 'nat-o1', nativeCumQty: '0', reason: 'unfilled at the deadline', sourceTs: c3.now(), receiptTs: c3.now() } }]); await r3.d.idle();
  s = r3.d.state(); assert.equal(s.orders.o1.state, 'EXPIRED'); assert.equal(s.positions.p1.state, 'FLAT'); assert.equal(s.reservations.r1.state, 'RELEASED'); assert.equal(slotsUsed(s), 0); assert.equal(availableCash(s), s.cash);
  // idempotent: a second terminal report does not close anything twice or throw
  a3.emit([{ type: 'ORDER_STATE', payload: { orderId: 'o1', state: 'EXPIRED', nativeOrderId: 'nat-o1', nativeCumQty: '0', reason: 'again', sourceTs: c3.now(), receiptTs: c3.now() } }]); await r3.d.idle();
  assert.equal(r3.d.state().positions.p1.state, 'FLAT'); assert.equal(r3.d.status().counters.shellsFlattened, 1);
  // a PARTIALLY filled terminal entry is NOT a shell: it stays a position with inventory
  const c4 = fakeClock(); const a4 = venue(); const r4 = await rig({ accountId: 'fix83-3d', adapter: a4, feed: freshFeed(c4), clock: c4 }); await r4.d.dispatchEntry('o1'); const t = c4.now();
  a4.emit([{ type: 'EXECUTION_RECORDED', payload: { orderId: 'o1', execId: 'x1', nativeOrderId: 'nat-o1', side: 'buy', base: '0.0005', quote: '50', price: '100000', fee: { asset: 'USD', amount: '0.4' }, sourceTs: t, receiptTs: t, origin: 'PAPER', ordRefId: null, nativeCumQty: null, sequence: null } }, { type: 'ORDER_STATE', payload: { orderId: 'o1', state: 'EXPIRED', nativeOrderId: 'nat-o1', nativeCumQty: '0.0005', reason: 'partial then expired', sourceTs: t, receiptTs: t } }]); await r4.d.idle();
  s = r4.d.state(); assert.equal(s.orders.o1.state, 'EXPIRED'); assert.notEqual(s.positions.p1.state, 'FLAT'); assert.equal(s.positions.p1.confirmedBase, '0.0005'); assert.equal(r4.d.status().counters.shellsFlattened ?? 0, 0);
});

test('FIX83-4. a synchronous adapter burst (fill, ORDER_STATE, stop PENDING, stop ACTIVE) commits as ONE append, mapped against the state the burst produces; a refused burst falls back to one-by-one', async () => {
  const c = fakeClock(); const ad = venue(); const r = await rig({ accountId: 'fix83-4', adapter: ad, feed: freshFeed(c), clock: c }); await r.d.dispatchEntry('o1'); const before = r.d.status().counters.commits; const t = c.now();
  ad.emit([
    { type: 'EXECUTION_RECORDED', payload: { orderId: 'o1', execId: 'x1', nativeOrderId: 'nat-o1', side: 'buy', base: '0.001', quote: '100', price: '100000', fee: { asset: 'USD', amount: '0.8' }, sourceTs: t, receiptTs: t, origin: 'PAPER', ordRefId: null, nativeCumQty: null, sequence: null } },
    { type: 'ORDER_STATE', payload: { orderId: 'o1', state: 'FILLED', nativeOrderId: 'nat-o1', nativeCumQty: '0.001', reason: null, sourceTs: t, receiptTs: t } },
    { type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, nativeOrderId: null, state: 'PENDING', qty: '0.001', trigger: '99000', reason: 'stop placement pending', sourceTs: t, receiptTs: t } },
    { type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, nativeOrderId: 'nat-stop-1', state: 'ACTIVE', qty: '0.001', trigger: '99000', reason: 'stop working', sourceTs: t, receiptTs: t } },
  ]); await r.d.idle();
  const s = r.d.state(); const after = r.d.status().counters.commits;
  assert.equal(s.orders.o1.state, 'FILLED'); assert.equal(s.positions.p1.state, 'OPEN'); assert.equal(s.positions.p1.protection.state, 'ACTIVE', JSON.stringify(s.positions.p1.protection));
  const stop = Object.values(s.orders).find((o) => o.kind === 'PROTECTIVE_STOP'); assert.ok(stop, 'the native child got its journal order'); assert.equal(stop.qty, M.sub(M.sub('0.001', '0'), s.positions.p1.baseFees ?? '0'), 'the stop qty is the OWNED base after the fill, not the pre-fill zero');
  assert.equal(r.d.status().counters.adapterBatches, 1, 'one batch'); assert.equal(after - before, 2, 'ONE append for the burst plus the reservation settlement'); assert.equal(s.reservations.r1.state, 'CONSUMED');
  // a burst the reducer refuses as a whole (state for an unknown order after a duplicate fill) is applied one by one, nothing dropped
  const before2 = r.d.status().counters.commits; ad.emit([{ type: 'EXECUTION_RECORDED', payload: { orderId: 'o1', execId: 'x1', nativeOrderId: 'nat-o1', side: 'buy', base: '0.001', quote: '100', price: '100000', fee: { asset: 'USD', amount: '0.8' }, sourceTs: t, receiptTs: t, origin: 'PAPER', ordRefId: null, nativeCumQty: null, sequence: null } }, { type: 'ORDER_STATE', payload: { orderId: 'ghost', state: 'FILLED', nativeOrderId: 'nat-ghost', nativeCumQty: '1', reason: null, sourceTs: t, receiptTs: t } }]); await r.d.idle();
  const s2 = r.d.state(); assert.equal(s2.positions.p1.confirmedBase, '0.001', 'the duplicate execution is not booked twice'); assert.ok((s2.externalActivity ?? []).some((x) => x.ref === 'nat-ghost'), `the unknown-order state was still booked as external activity: ${JSON.stringify(s2.externalActivity)} commits ${r.d.status().counters.commits - before2}`);
  assert.equal(r.d.status().counters.adapterBatches, 1, 'the refused burst did not count as a batch');
});

test('FIX83-9a. feed.unpin steps a pinned symbol down to CANDIDATE and keeps its book, trade ring and trade coverage; with candidate slots full it releases outright', () => {
  const clock = fakeClock(); const feed = createExecutionFeed({ clock: clock.now, limits: { maxCandidates: 2 } }); feed.onConnect(clock.now());
  feed.admit('XBT/USD', { priority: 'PENDING', reason: 'p1' }); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: [{ price: '100010.0', qty: '5' }], bids: [{ price: '99990.0', qty: '5' }] }] }), clock.now());
  clock.advance(5 * 60_000); feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side: 'buy', price: 100000, qty: 0.1, ord_type: 'market', trade_id: 1, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const covBefore = feed.coverage('XBT/USD'); assert.ok(covBefore && Number.isSafeInteger(covBefore.startTs), JSON.stringify(covBefore));
  const u = feed.unpin('XBT/USD'); assert.deepEqual(u, { ok: true, symbol: 'XBT/USD', priority: 'CANDIDATE', kept: true }); assert.equal(feed.pinned().has('XBT/USD'), false);
  const covAfter = feed.coverage('XBT/USD'); assert.deepEqual(covAfter, covBefore, 'trade coverage survives the unpin'); assert.ok(feed.health('XBT/USD')?.synced, 'the book survives the unpin');
  assert.deepEqual(feed.unpin('XBT/USD'), { ok: true, symbol: 'XBT/USD', priority: 'CANDIDATE', kept: true }, 'idempotent'); assert.deepEqual(feed.unpin('ETH/USD'), { ok: true, absent: true });
  // candidate slots full: the old force-release law
  feed.admit('SOL/USD', { priority: 'CANDIDATE' }); feed.admit('ETH/USD', { priority: 'PENDING', reason: 'p2' }); const admittedBefore = feed.status().admitted; const u2 = feed.unpin('ETH/USD'); assert.equal(u2.released, true); assert.equal(feed.status().admitted, admittedBefore - 1, 'released outright'); assert.equal(feed.pinned().has('ETH/USD'), false);
});

test('FIX83-9b. a preparation tenant still inside its warm-up is not preempted by a newer nomination; once warm it is (the old law), and fairness rotation is untouched', () => {
  const t = T0; const n = (assetId, knownAt) => ({ symbol: `${assetId}/USD`, assetId, source: 'VOLATILITY', nominationKnownAtTs: knownAt, nominationLastSeenTs: t + 30 * 60_000 });
  const previous = new Map([['AAA', { assetId: 'AAA', symbol: 'AAA/USD', source: 'VOLATILITY', nominationKnownAtTs: t, nominationDigest: `VOLATILITY|${t}`, preparedSinceTs: t + 25 * 60_000, rankTs: t }], ['BBB', { assetId: 'BBB', symbol: 'BBB/USD', source: 'VOLATILITY', nominationKnownAtTs: t + 1000, nominationDigest: `VOLATILITY|${t + 1000}`, preparedSinceTs: t, rankTs: t + 1000 }]]);
  const now = t + 30 * 60_000; // AAA has warmed 5 min (protected), BBB 30 min (warm, preemptable)
  const sel = selectPreparation({ nominations: [n('AAA', t), n('BBB', t + 1000), n('CCC', now - 1000)], remainingSlots: 2, previous, nowTs: now });
  assert.deepEqual(sel.selected.map((s) => s.assetId).sort(), ['AAA', 'CCC'], 'the newer CCC preempts the WARM tenant, never the warming one'); assert.deepEqual(sel.lost.map((l) => [l.assetId, l.reason]), [['BBB', 'PREEMPTED_BY_NEWER_NOMINATION']]);
  // without protection (the old law) CCC would have preempted AAA, the oldest nomination
  const old = selectPreparation({ nominations: [n('AAA', t), n('BBB', t + 1000), n('CCC', now - 1000)], remainingSlots: 2, previous, nowTs: now, warmupProtectMs: 0 });
  assert.deepEqual(old.selected.map((s) => s.assetId).sort(), ['BBB', 'CCC']);
  // a warming tenant that is no longer nominated still ages out (protection is never a resurrection)
  const gone = selectPreparation({ nominations: [n('BBB', t + 1000), n('CCC', now - 1000)], remainingSlots: 2, previous, nowTs: now });
  assert.deepEqual(gone.selected.map((s) => s.assetId).sort(), ['BBB', 'CCC']); assert.deepEqual(gone.lost.map((l) => [l.assetId, l.reason]), [['AAA', 'NOMINATION_EXPIRED']]);
});

test('FIX83-16. the commit pump has two lanes: a priority commit (entry, fill, exit) runs ahead of every WAITING ordinary commit, never interrupts a running one, and each lane keeps its order', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'fix83-16', clock }); const { F } = r;
  const slow = { ...r.journal, append: async (...args) => { await new Promise((res) => setTimeout(res, 5)); return r.journal.append(...args); } }; // every append takes a round trip
  const d = createDispatcher({ accountId: r.accountId, journal: slow, writer: r.writer, adapter: { kind: 'PAPER', async drain() { return {}; }, async reconcile() { return { outcome: 'COMPLETE', unmatched: 0, pageIncomplete: false }; }, status() { return { stops: [], counters: {} }; } }, clock, specOf: () => SPEC, feeOf: () => TAKER_FEE }); await d.load();
  const order = []; d.onCommit((_s, list) => order.push(list[0].payload.reason ?? list[0].type));
  const val = (i) => F.ev('RESTRICTION', { code: 'VETO', action: 'LATCH', scope: `pred-${i}`, source: 'test', sessionDate: null, reason: `ordinary-${i}`, ownerRef: null, ts: clock.now() });
  const a = d.commit(val(1)); const b = d.commit(val(2)); const c = d.commit(val(3)); // three ordinary commits queued
  await new Promise((res) => setTimeout(res, 1)); // ordinary-1 is now RUNNING inside its slow append
  const p = d.commit([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')], { priority: true }); const q = d.commit(val(4), { priority: true });
  await Promise.all([a, b, c, p, q]);
  assert.deepEqual(order, ['ordinary-1', 'HYPOTHESIS_LOCKED', 'ordinary-4', 'ordinary-2', 'ordinary-3'], 'the running commit finishes, then the priority lane in its order, then the ordinary lane in its order');
  assert.equal(d.status().counters.priorityCommits, 2);
  // a refused priority commit rejects its own caller only; the pump carries on
  await assert.rejects(d.commit(F.ev('ORDER_STATE', { orderId: 'ghost', state: 'FILLED', nativeOrderId: null, nativeCumQty: '1', reason: null, sourceTs: clock.now(), receiptTs: clock.now() }), { priority: true }), (e) => e.code === 'REDUCER_REFUSED');
  await d.commit(val(5)); assert.equal(order[order.length - 1], 'ordinary-5'); await d.idle();
});
