// Focused review: an owner KILL arriving during an already-serialized planned
// exit must upgrade that coordinator, not start a competing sell and not wait
// behind the lower-priority planned-exit policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createWatch } from '../watch/watch.js';
import { eventsFor, fakeClock, SPEC, TAKER_FEE } from './helpers/judge.js';

async function plannedExitInProgress() {
  const accountId = 'watch-kill-escalation-review';
  const clock = fakeClock();
  const journal = createMemoryJournal();
  await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId);
  const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now });
  feed.admit('XBT/USD', { priority: 'PENDING', reason: 'test' });
  feed.onConnect(clock.now());
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TAKER_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC });
  await dispatcher.load();
  const controls = { kill: false, cage: false };
  const watch = createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => controls });
  await dispatcher.commit(F.init());

  const book = (asks, bids, type = 'update') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };

  await dispatcher.commit([
    F.hypothesis('d1'),
    F.decision('d1', { sizing: { q: '0.001', entryLimitPrice: '100000', entryCashOut: '101', riskUsd: '4', bufferedScenarioNetProfit: '2' } }),
    F.reserve('r1', 'd1', { cashReserved: '101' }),
    F.position('p1', 'd1', { structuralStop: '99500', targetPrice: '102000' }),
    F.pin(),
    F.intent('o1', 'p1', 'r1', { protection: { ordertype: 'stop-loss', trigger: 'last', price: '99500' } }),
  ]);
  book([[99990, 5]], [[99980, 5], [99970, 5]], 'snapshot');
  await dispatcher.dispatchEntry('o1');
  clock.advance(300);
  book([[99990, 5]], [[99980, 5], [99970, 5]]);
  await settle();
  assert.equal(dispatcher.state().positions.p1.initialR.state, 'FINAL');
  assert.equal(dispatcher.state().positions.p1.protection.state, 'ACTIVE');

  clock.advance(1_000);
  book([[102400, 5]], [[102390, 5], [102380, 5]]);
  await settle();
  const exit = watch.positions()[0].exit;
  assert.equal(exit.reason, 'PLANNED_TARGET');
  assert.notEqual(exit.phase, 'NONE');
  const openBefore = Object.values(dispatcher.state().orders).filter((o) => o.positionId === 'p1' && o.side === 'sell' && !['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.state));
  assert.equal(openBefore.length, 1, `the fixture needs one ordinary sell in flight: ${JSON.stringify(openBefore.map((o) => [o.orderId, o.kind, o.state]))}`);
  assert.equal(openBefore[0].kind, 'PLANNED_EXIT');
  return { accountId, clock, journal, feed, adapter, dispatcher, watch, controls, book, settle };
}

async function escalationEvents(r) {
  const rows = await r.journal.page(r.accountId, { afterSeq: 0, limit: 500 });
  return {
    kill: rows.filter(({ event }) => event.type === 'RESTRICTION' && event.payload.code === 'KILL').length,
    ownerWatch: rows.filter(({ event }) => event.type === 'WATCH_STATE' && event.payload.primaryReason === 'OWNER_KILL').length,
  };
}

const openSellsOf = (r) => Object.values(r.dispatcher.state().orders).filter((o) => o.positionId === 'p1' && o.side === 'sell' && !['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.state));

test('owner KILL escalates an in-progress planned exit in place without a second competing sell', async () => {
  const r = await plannedExitInProgress();
  r.controls.kill = true;
  r.clock.advance(1);
  await r.settle();

  const exit = r.watch.positions()[0].exit;
  const openSells = openSellsOf(r);
  assert.ok(openSells.length <= 1, `the escalation reuses the coordinator and never exposes two sells: ${JSON.stringify(openSells.map((o) => [o.orderId, o.kind, o.state]))}`);
  assert.ok(openSells.every((o) => M.lte(M.sub(o.qty, o.filledBase), '0.001')), 'the reducer-visible outstanding quantity never exceeds owned inventory');
  assert.deepEqual({
    reason: exit.reason,
    priority: exit.priority,
    protective: exit.protective,
    killLatched: Boolean(r.dispatcher.state().restrictions.KILL),
    killRequested: r.watch.status().counters.killRequested,
  }, {
    reason: 'OWNER_KILL',
    priority: 'P1_KILL_OR_INVALID_PROTECTION',
    protective: true,
    killLatched: true,
    killRequested: 1,
  }, 'the lower-priority exit coordinator must be upgraded and owner KILL durably latched exactly once');
});

test('a delayed planned-order cancel may book a partial fill; KILL then sells only the confirmed residual and repeated heartbeats append no extra escalation', async () => {
  const r = await plannedExitInProgress();
  const planned = openSellsOf(r)[0];
  const originalCancel = r.adapter.cancelOwnedOrder.bind(r.adapter);
  let releaseCancel;
  const held = new Promise((resolve) => { releaseCancel = resolve; });
  let cancelStarted;
  const started = new Promise((resolve) => { cancelStarted = resolve; });
  r.adapter.cancelOwnedOrder = async (request) => {
    if (request.orderId === planned.orderId) { cancelStarted(); await held; }
    return originalCancel(request);
  };

  r.controls.kill = true;
  r.clock.advance(1);
  const killTick = r.watch.onTick(r.clock.now());
  await started;
  assert.equal(r.dispatcher.state().orders[planned.orderId].state, 'CANCEL_PENDING', 'the original planned sell is the only sell while its cancellation is unresolved');
  assert.equal(openSellsOf(r).length, 1);

  // The planned IOC executes partially while its cancel acknowledgement is in
  // flight. Those received economics win; the eventual replacement must use
  // only the reducer-confirmed residual.
  r.clock.advance(300);
  r.book([[102400, 5]], [[102390, 0.0004]], 'snapshot');
  await r.dispatcher.idle();
  assert.equal(r.dispatcher.state().orders[planned.orderId].state, 'EXPIRED');
  assert.equal(r.dispatcher.state().positions.p1.soldBase, '0.0004');
  assert.equal(r.dispatcher.state().positions.p1.state, 'EXITING', 'partial execution is not flat');
  releaseCancel();
  await killTick;
  await r.dispatcher.idle();
  assert.equal(openSellsOf(r).length, 0, 'terminal confirmation precedes any replacement');

  const once = await escalationEvents(r);
  assert.deepEqual(once, { kill: 1, ownerWatch: 1 });
  r.clock.advance(1);
  await r.settle();
  const afterRepeat = await escalationEvents(r);
  assert.deepEqual(afterRepeat, once, 'a held KILL and repeated heartbeat append no duplicate escalation records');
  const protective = openSellsOf(r);
  assert.equal(protective.length, 1);
  assert.equal(protective[0].kind, 'PROTECTIVE_EXIT');
  assert.equal(protective[0].qty, '0.0006', 'replacement is exactly the confirmed residual after the partial planned fill');
  assert.equal(r.dispatcher.state().positions.p1.state, 'EXITING', 'submission/acknowledgement is never called flat');

  r.clock.advance(300);
  r.book([[102400, 5]], [[102380, 1]]);
  await r.dispatcher.idle();
  await r.watch.onTick(r.clock.now());
  await r.dispatcher.idle();
  assert.equal(r.dispatcher.state().positions.p1.state, 'FLAT', 'only the confirmed residual fill permits closure');
  assert.equal(r.watch.killComplete(), true);
  assert.equal(openSellsOf(r).length, 0);
});

test('an unknown planned-order cancellation latches KILL but fails closed with no protective replacement or flat fiction', async () => {
  const r = await plannedExitInProgress();
  const planned = openSellsOf(r)[0];
  const originalCancel = r.adapter.cancelOwnedOrder.bind(r.adapter);
  r.adapter.cancelOwnedOrder = async (request) => (request.orderId === planned.orderId ? { outcome: 'UNCERTAIN', reason: 'response lost after cancel send' } : originalCancel(request));
  r.controls.kill = true;
  r.clock.advance(1);
  await r.settle();

  assert.equal(r.watch.positions()[0].exit.reason, 'OWNER_KILL');
  assert.equal(r.watch.positions()[0].exit.phase, 'UNRESOLVED');
  assert.equal(r.dispatcher.state().orders[planned.orderId].state, 'RECONCILIATION_REQUIRED');
  assert.ok(r.dispatcher.state().restrictions.KILL);
  assert.ok(r.dispatcher.state().restrictions.RECONCILIATION_REQUIRED);
  assert.equal(Object.values(r.dispatcher.state().orders).filter((o) => o.kind === 'PROTECTIVE_EXIT').length, 0, 'unknown cancellation cannot authorize a second sell');
  assert.notEqual(r.dispatcher.state().positions.p1.state, 'FLAT');
  const once = await escalationEvents(r);
  r.clock.advance(250);
  await r.settle();
  assert.deepEqual(await escalationEvents(r), once, 'the unresolved loop does not duplicate the owner escalation');
  assert.equal(Object.values(r.dispatcher.state().orders).filter((o) => o.kind === 'PROTECTIVE_EXIT').length, 0);
});

test('restart reconstructs a pending protective conversion from durable OWNER_KILL plus an open planned-origin sell', async () => {
  const r = await plannedExitInProgress();
  const planned = openSellsOf(r)[0];
  const prior = r.dispatcher.state().positions.p1.exit;
  await r.dispatcher.commit([
    r.dispatcher.ev('RESTRICTION', { code: 'KILL', action: 'LATCH', scope: null, source: 'watch:owner-kill', sessionDate: null, reason: 'owner KILL: halt additions, attempt a safe flatten, stay killed', ownerRef: null, ts: r.clock.now() }),
    r.dispatcher.ev('WATCH_STATE', { positionId: 'p1', trailActive: false, highestBid: prior.highestBid ?? null, exitState: 'REQUESTED', primaryReason: 'OWNER_KILL', priority: 'P1_KILL_OR_INVALID_PROTECTION', supportedReasons: ['OWNER_KILL', 'PLANNED_TARGET'], ts: r.clock.now() }),
  ]);

  const pclock = { now: r.clock.now, monotonic: r.clock.monotonic };
  const restored = createWatch({ accountId: r.accountId, dispatcher: r.dispatcher, adapter: r.adapter, feed: r.feed, clock: pclock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => ({ kill: false, cage: false }) });
  const before = restored.track(r.dispatcher.state().positions.p1).exit;
  assert.deepEqual({ reason: before.reason, orderId: before.orderId, protective: before.protective, plannedOrigin: before.plannedOrigin, protectiveRequested: before.protectiveRequested }, {
    reason: 'OWNER_KILL', orderId: planned.orderId, protective: true, plannedOrigin: true, protectiveRequested: true,
  });
  await restored.onTick(r.clock.now());
  await r.dispatcher.idle();
  assert.ok(['CANCELLED', 'EXPIRED', 'FILLED', 'REJECTED'].includes(r.dispatcher.state().orders[planned.orderId].state), 'restart does not wait a fresh timeout: cancel/reconciliation first makes the planned sell terminal');
  const open = openSellsOf(r);
  assert.ok(open.length <= 1 && open.every((o) => o.kind === 'PROTECTIVE_EXIT'), `terminal planned-order resolution precedes a single protective replacement: ${JSON.stringify(open.map((o) => [o.orderId, o.kind, o.state]))}`);
  assert.deepEqual(await escalationEvents(r), { kill: 1, ownerWatch: 1 }, 'restore reuses durable escalation and appends no duplicate owner event');
});

test('a failed atomic KILL upgrade leaves the coordinator untouched; retry commits one escalation and preserves identity clocks', async () => {
  const r = await plannedExitInProgress();
  let failUpgrade = true;
  const proxy = {
    state: r.dispatcher.state,
    ev: r.dispatcher.ev,
    writerHeld: r.dispatcher.writerHeld,
    writerLost: r.dispatcher.writerLost,
    status: r.dispatcher.status,
    reconcileNow: r.dispatcher.reconcileNow,
    commit: async (events, options) => {
      const list = Array.isArray(events) ? events : [events];
      const atomicUpgrade = list.some((e) => e.type === 'RESTRICTION' && e.payload.code === 'KILL') && list.some((e) => e.type === 'WATCH_STATE' && e.payload.primaryReason === 'OWNER_KILL');
      if (failUpgrade && atomicUpgrade) { failUpgrade = false; throw new Error('injected journal append failure'); }
      return r.dispatcher.commit(events, options);
    },
  };
  const logs = [];
  const pclock = { now: r.clock.now, monotonic: r.clock.monotonic };
  const retrying = createWatch({ accountId: r.accountId, dispatcher: proxy, adapter: r.adapter, feed: r.feed, clock: pclock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => ({ kill: true, cage: false }), log: (line) => logs.push(line) });
  const before = structuredClone(retrying.track(r.dispatcher.state().positions.p1).exit);

  r.clock.advance(1);
  await retrying.onTick(r.clock.now());
  const failed = retrying.positions()[0].exit;
  assert.deepEqual(failed, before, 'failed durable upgrade cannot mutate phase, reason, order, clocks, or protective state');
  assert.equal(retrying.status().counters.killRequested, 0);
  assert.deepEqual(await escalationEvents(r), { kill: 0, ownerWatch: 0 });
  assert.ok(logs.some((line) => /injected journal append failure/.test(line)));

  r.clock.advance(1);
  await retrying.onTick(r.clock.now());
  await r.dispatcher.idle();
  const retried = retrying.positions()[0].exit;
  assert.equal(retried.reason, 'OWNER_KILL');
  assert.equal(retried.orderId, before.orderId);
  assert.equal(retried.startedMono, before.startedMono);
  assert.equal(retried.startedTs, before.startedTs);
  assert.equal(retrying.status().counters.killRequested, 1);
  assert.deepEqual(await escalationEvents(r), { kill: 1, ownerWatch: 1 });
  r.clock.advance(250);
  await retrying.onTick(r.clock.now());
  assert.equal(retrying.status().counters.killRequested, 1);
  assert.deepEqual(await escalationEvents(r), { kill: 1, ownerWatch: 1 }, 'held KILL is not re-appended after the successful retry');
});
