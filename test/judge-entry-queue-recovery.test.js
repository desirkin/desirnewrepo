import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, DISPATCHER_DEFAULTS } from '../execution/dispatcher.js';
import { paperAccount, SPEC, TAKER_FEE } from './helpers/judge.js';

function adapter({ uncertain = false } = {}) {
  const calls = { entries: 0, reductions: 0, reconciles: 0 };
  return {
    kind: 'PAPER', calls, stopAdmission() {}, async drain() { return {}; },
    async submitEntryWithProtection() { calls.entries += 1; return uncertain ? { outcome: 'UNCERTAIN', nativeOrderId: null, reason: 'wire result unknown', guaranteesNoAcceptance: false } : { outcome: 'ACKNOWLEDGED', nativeOrderId: 'native-entry', reason: null, guaranteesNoAcceptance: false }; },
    async closeResidual() { calls.reductions += 1; return { outcome: 'ACKNOWLEDGED', nativeOrderId: 'native-exit', reason: null, guaranteesNoAcceptance: false }; },
    async reconcile() { calls.reconciles += 1; return { outcome: 'INCOMPLETE', unmatched: 0, pageIncomplete: true, reason: 'fixture retains uncertainty' }; },
  };
}

async function rig({ accountId, limits, uncertain = false } = {}) {
  const r = await paperAccount({ accountId });
  await r.append([r.F.hypothesis('d1'), r.F.decision('d1'), r.F.reserve('r1', 'd1'), r.F.position('p1', 'd1'), r.F.pin(), r.F.intent('o1', 'p1', 'r1')]);
  const venue = adapter({ uncertain });
  const feed = { releases: 0, release() { this.releases += 1; }, health: () => ({ usable: true }) };
  const dispatcher = createDispatcher({ accountId, journal: r.journal, writer: r.writer, adapter: venue, clock: r.clock, feed, specOf: () => SPEC, feeOf: () => TAKER_FEE, limits });
  await dispatcher.load();
  return { ...r, dispatcher, venue, feed };
}

function assertCompensated(state) {
  assert.equal(state.orders.o1.state, 'CANCELLED');
  assert.equal(state.orders.o1.attempts.length, 0);
  assert.equal(state.orders.o1.nativeOrderId, null);
  assert.equal(state.reservations.r1.state, 'RELEASED');
  assert.equal(state.reservations.r1.releaseReason, 'CANCELLED_UNSENT');
  assert.equal(state.positions.p1.state, 'FLAT');
  assert.equal(state.positions.p1.confirmedBase, '0');
  assert.equal(state.pins['XBT/USD'], undefined);
}

test('ENTRY_QUEUE_FULL after durable intent atomically compensates order, reservation, zero-inventory shell, and pin exactly once', async () => {
  const r = await rig({ accountId: 'queue-full-compensation', limits: { ...DISPATCHER_DEFAULTS, maxEntryQueue: 1 } });
  let release; const held = new Promise((resolve) => { release = resolve; });
  const active = r.dispatcher.enqueue('ENTRY', () => held);
  const queued = r.dispatcher.enqueue('ENTRY', async () => 'placeholder');
  await assert.rejects(r.dispatcher.queueEntry('o1'), (error) => error.code === 'ENTRY_QUEUE_FULL');
  assertCompensated(r.dispatcher.state());
  assert.equal(r.venue.calls.entries, 0, 'queue refusal never reaches the adapter');
  assert.equal(r.feed.releases, 1, 'the local feed pin follows durable release');
  assert.equal(r.dispatcher.status().counters.queueCompensations, 1);
  assert.equal((await r.journal.replayVerify(r.accountId)).ok, true);
  assert.equal((await r.dispatcher.compensateUnattemptedEntry('o1', 'DUPLICATE_RETRY')).outcome, 'EXISTING');
  assert.equal(r.dispatcher.status().counters.queueCompensations, 1, 'idempotent retry appends nothing');
  release(); await Promise.all([active, queued]);
});

test('OVERLOAD refusal compensates entry while the SAFETY lane and protective reduction remain available', async () => {
  const r = await rig({ accountId: 'queue-overload-compensation', limits: { ...DISPATCHER_DEFAULTS, maxSafetyQueue: 1 } });
  let release; const held = new Promise((resolve) => { release = resolve; });
  const active = r.dispatcher.enqueue('SAFETY', () => held);
  const queued = r.dispatcher.enqueue('SAFETY', async () => 'second');
  const overflow = r.dispatcher.enqueue('SAFETY', async () => r.venue.closeResidual());
  await assert.rejects(r.dispatcher.queueEntry('o1'), (error) => error.code === 'OVERLOAD');
  assertCompensated(r.dispatcher.state());
  assert.equal(r.venue.calls.entries, 0);
  release(); await Promise.all([active, queued, overflow]);
  assert.equal(r.venue.calls.reductions, 1, 'entry overload never blocks the SAFETY/protective lane');
});

test('restart recovers only durable zero-attempt entries, is repeatable, and never retries them', async () => {
  const r = await rig({ accountId: 'queue-restart-compensation' });
  const first = await r.dispatcher.restart({ scope: 'STARTUP' });
  assert.deepEqual(first.resolved, ['o1']);
  assert.deepEqual(first.uncertainOrders, []);
  assertCompensated(r.dispatcher.state());
  assert.equal(r.venue.calls.entries, 0);
  const revision = r.dispatcher.revision();
  const second = await r.dispatcher.restart({ scope: 'STARTUP' });
  assert.deepEqual(second.resolved, []);
  assert.equal(r.dispatcher.revision(), revision, 'repeated restart appends no duplicate cleanup');
  assert.equal((await r.journal.replayVerify(r.accountId)).ok, true);
});

test('uncertain/attempted entry is never compensated or resent by restart', async () => {
  const r = await rig({ accountId: 'queue-uncertain-preserved', uncertain: true });
  const sent = await r.dispatcher.dispatchEntry('o1');
  assert.equal(sent.outcome, 'UNCERTAIN');
  assert.equal(r.dispatcher.state().orders.o1.state, 'DISPATCH_UNCERTAIN');
  await assert.rejects(r.dispatcher.compensateUnattemptedEntry('o1', 'QUEUE_REJECTED'), (error) => error.code === 'ENTRY_COMPENSATION_UNSAFE');
  const beforeAttempts = r.dispatcher.state().orders.o1.attempts.length;
  const report = await r.dispatcher.restart({ scope: 'STARTUP' });
  assert.deepEqual(report.resolved, []);
  assert.ok(report.uncertainOrders.includes('o1'));
  assert.equal(r.dispatcher.state().orders.o1.state, 'DISPATCH_UNCERTAIN');
  assert.equal(r.dispatcher.state().orders.o1.attempts.length, beforeAttempts);
  assert.equal(r.venue.calls.entries, 1, 'restart reconciles; it never blind-resends');
});

test('concurrent dispatch and compensation serialize on journal CAS: exactly one wins and no sent order is cancelled', async () => {
  const r = await rig({ accountId: 'queue-concurrent-compensation' });
  const other = createDispatcher({ accountId: r.accountId, journal: r.journal, writer: r.writer, adapter: r.venue, clock: r.clock, feed: r.feed, specOf: () => SPEC, feeOf: () => TAKER_FEE });
  await other.load();
  const [dispatch, compensation] = await Promise.allSettled([
    r.dispatcher.dispatchEntry('o1'),
    other.compensateUnattemptedEntry('o1', 'CONCURRENT_QUEUE_REFUSAL'),
  ]);
  await r.dispatcher.load();
  const state = r.dispatcher.state();
  if (r.venue.calls.entries === 1) {
    assert.equal(dispatch.status, 'fulfilled');
    assert.equal(compensation.status, 'rejected');
    assert.notEqual(state.orders.o1.state, 'CANCELLED', 'a durably attempted/sent order is never compensated');
  } else {
    assert.equal(r.venue.calls.entries, 0);
    assert.equal(compensation.status, 'fulfilled');
    assertCompensated(state);
    assert.equal(dispatch.status, 'rejected');
  }
  assert.equal((await r.journal.replayVerify(r.accountId)).ok, true);
});
