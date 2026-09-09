// CLOSEOUT R02 / R04 — cancel the protective children, CONFIRM their cancellation, RECONCILE through the race, then ONE
// serialized sale of the confirmed net residual inside owned inventory; protection is a SET of confirmed children.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createWatch } from '../watch/watch.js';
import { adapterEvent } from '../execution/adapter-contract.js';
import { paperAccount, fakeClock, SPEC, TAKER_FEE, T0 } from './helpers/judge.js';

// a KRAKEN-shaped venue double with a scripted late stop fill and unrelated inventory; every call is counted
function venue({ lateFill = null, extraInventory = '0', cancel = 'CANCELLED' } = {}) {
  const listeners = new Set(); const calls = { cancels: [], reconciles: 0, sells: [], entries: 0 };
  const emit = (type, payload, ts) => { const ev = adapterEvent('KRAKEN', type, payload, ts); for (const fn of listeners) fn(ev); return ev; };
  return { kind: 'KRAKEN', calls, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, stopAdmission() {}, async drain() { return {}; },
    async cancelOwnedOrder({ orderId, nativeOrderId }) { calls.cancels.push({ orderId, nativeOrderId }); return { outcome: cancel, reason: null }; },
    async reconcile({ scope }) { calls.reconciles += 1; const ts = T0 + 1000 * calls.reconciles; if (lateFill && calls.reconciles === 1) emit('EXECUTION_RECORDED', { orderId: null, execId: `late-${calls.reconciles}`, nativeOrderId: lateFill.nativeOrderId, side: 'sell', base: lateFill.base, quote: M.mul(lateFill.base, '99000'), price: '99000', fee: { asset: 'USD', amount: '0' }, sourceTs: ts, receiptTs: ts, origin: 'REST_RECONCILIATION', ordRefId: 'nat-o1', nativeCumQty: null, sequence: null }, ts); return emit('RECONCILIATION', { reconciliationId: `rec-${calls.reconciles}`, scope, outcome: 'COMPLETE', balances: { quoteAvailable: '400', quoteTotal: '400', baseByAsset: [{ asset: 'XXBT', total: M.add('0.001', extraInventory), available: null }] }, openOrdersSeen: 0, executionsSeen: lateFill ? 1 : 0, unmatched: 0, pagesRead: 1, pageIncomplete: false, cursorTs: ts, reason: null, ts }, ts).payload; },
    async closeResidual({ intent }) { calls.sells.push({ orderId: intent.orderId, qty: intent.qty, kind: intent.kind }); return { outcome: 'ACKNOWLEDGED', nativeOrderId: `sell-${calls.sells.length}`, reason: null, guaranteesNoAcceptance: false }; },
    async submitEntryWithProtection() { calls.entries += 1; return { outcome: 'REJECTED', nativeOrderId: null, reason: 'never', guaranteesNoAcceptance: true }; }, async amendProtection() { return { outcome: 'FAILED', confirmedTrigger: null, reason: 'x' }; } };
}
async function protectedPosition({ accountId, clock = fakeClock(), ad }) {
  const r = await paperAccount({ accountId, clock }); const { F } = r;
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), F.stopIntent('st1', 'p1'), F.attempt('st1'), F.result('st1', 'ACKNOWLEDGED', { nativeOrderId: 'nat-st1' }), F.protection('p1', 'ACTIVE', { orderId: 'st1', nativeOrderId: 'nat-st1' }), F.r('p1', 'FINAL')]);
  const d = createDispatcher({ accountId, journal: r.journal, writer: r.writer, adapter: ad, clock, specOf: () => SPEC }); await d.load();
  const w = createWatch({ accountId, dispatcher: d, adapter: ad, clock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => ({ kill: true, cage: false }) });
  const ticks = async (n) => { for (let i = 0; i < n; i += 1) { await w.onTick(); await d.idle(); clock.advance(250); } };
  return { ...r, d, w, ad, ticks };
}

test('R02-01. the protective child is cancelled (acknowledged), the cancellation is confirmed, then the venue is RECONCILED before any sale: a late stop fill of the WHOLE quantity arrives through reconciliation -> zero sells, the position closes FLAT on the fill', async () => {
  const ad = venue({ lateFill: { nativeOrderId: 'nat-st1', base: '0.001' } }); const r = await protectedPosition({ accountId: 'race-full', ad });
  await r.ticks(6); const pos = r.d.state().positions.p1; const exit = r.w.positions()[0].exit;
  assert.equal(ad.calls.cancels.length, 1); assert.equal(ad.calls.reconciles, 1, 'R02-01: exactly one reconciliation between the cancel confirmation and the sale decision'); assert.equal(ad.calls.sells.length, 0, 'R02-01: the late stop fill is the truth, no sale'); assert.equal(pos.soldBase, '0.001'); assert.equal(pos.state, 'FLAT', JSON.stringify(exit)); assert.equal(exit.reconciliation?.outcome, 'COMPLETE');
});

test('R02-02. a PARTIAL late stop fill: one serialized sale of exactly the confirmed net residual (0.0006 after 0.0004 filled by the stop), never the pre-race quantity', async () => {
  const ad = venue({ lateFill: { nativeOrderId: 'nat-st1', base: '0.0004' } }); const r = await protectedPosition({ accountId: 'race-partial', ad });
  await r.ticks(6); assert.equal(ad.calls.reconciles, 1); assert.equal(ad.calls.sells.length, 1, JSON.stringify(r.w.positions()[0].exit)); assert.equal(ad.calls.sells[0].qty, '0.0006', 'R02-02: the confirmed net residual'); assert.equal(ad.calls.sells[0].kind, 'PROTECTIVE_EXIT'); assert.equal(r.d.state().positions.p1.soldBase, '0.0004');
});

test('R02-03. unrelated venue inventory (balance 5.001 BTC) never sizes the sale: the sale is the owned residual only; an oversell intent is refused by the reducer', async () => {
  const ad = venue({ lateFill: { nativeOrderId: 'nat-st1', base: '0.0004' }, extraInventory: '5' }); const r = await protectedPosition({ accountId: 'race-inventory', ad });
  await r.ticks(6); assert.equal(ad.calls.sells.length, 1); assert.equal(ad.calls.sells[0].qty, '0.0006', 'R02-03: owned residual, not the venue balance'); assert.equal(r.d.state().lastReconciliation.balances.baseByAsset[0].total, '5.001');
  await assert.rejects(r.d.commit(r.F.sellIntent('big', 'p1', { qty: '5' })), (e) => e.detail?.code === 'OVERSELL');
});

test('R02-04. reconciliation that is not COMPLETE never sells: an INCOMPLETE reconciliation halts the exit UNRESOLVED with the native stops retained', async () => {
  const ad = venue(); ad.reconcile = async ({ scope }) => { ad.calls.reconciles += 1; const ts = T0 + 5000; return adapterEvent('KRAKEN', 'RECONCILIATION', { reconciliationId: 'rec-inc', scope, outcome: 'INCOMPLETE', balances: null, openOrdersSeen: 0, executionsSeen: 0, unmatched: 0, pagesRead: 1, pageIncomplete: true, cursorTs: ts, reason: 'page bound', ts }, ts).payload; };
  const r = await protectedPosition({ accountId: 'race-incomplete', ad }); await r.ticks(6); assert.equal(ad.calls.sells.length, 0, 'R02-04: no sale on an incomplete reconciliation'); assert.equal(r.w.positions()[0].exit.phase, 'UNRESOLVED'); assert.equal(r.d.state().mode, 'HALTED_UNRESOLVED');
});

test('R04-01. two confirmed native children (one per partial fill) become TWO journal PROTECTIVE_STOP orders; protection is the set with coverage = the sum of confirmed children; each child\'s fill books against its own order; the Watch treats a fill whose child has not yet confirmed as unprotected only after the confirmation window', async () => {
  const r = await paperAccount({ accountId: 'kids' }); const { F } = r; await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1', { base: '0.0005', quote: '50', fee: { asset: 'USD', amount: '0.4' } })]);
  const ad = { kind: 'KRAKEN', stopAdmission() {}, async drain() { return {}; } }; const d = createDispatcher({ accountId: 'kids', journal: r.journal, writer: r.writer, adapter: ad, clock: r.clock, specOf: () => SPEC }); await d.load();
  await d.applyAdapterEvent({ type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, state: 'ACTIVE', nativeOrderId: 'child-A', trigger: '99000', qty: '0.0005', sourceTs: T0, receiptTs: T0, reason: null } });
  await d.commit(F.fill('o1', 'f2', { base: '0.0005', quote: '50', fee: { asset: 'USD', amount: '0.4' } })); const w = createWatch({ accountId: 'kids', dispatcher: d, adapter: ad, clock: r.clock, specOf: () => SPEC, feeOf: () => TAKER_FEE }); await w.onTick(); assert.equal(w.evaluateReasons(d.state().positions.p1).reasons.includes('PROTECTION_INVALID'), false, 'inside the confirmation window after the second fill: not yet invalid');
  await d.applyAdapterEvent({ type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, state: 'ACTIVE', nativeOrderId: 'child-B', trigger: '99000', qty: '0.0005', sourceTs: T0, receiptTs: T0, reason: null } });
  let s = d.state(); const stops = Object.values(s.orders).filter((o) => o.kind === 'PROTECTIVE_STOP'); assert.equal(stops.length, 2, 'R04-01: one journal order per confirmed child'); assert.deepEqual(stops.map((o) => o.nativeOrderId).sort(), ['child-A', 'child-B']);
  const kids = Object.values(s.positions.p1.protection.children); assert.equal(kids.length, 2); assert.equal(s.positions.p1.protection.state, 'ACTIVE'); assert.equal(s.positions.p1.protection.coverage, '0.001'); assert.equal(s.restrictions.PROTECTION_MISMATCH, undefined);
  await d.applyAdapterEvent({ type: 'EXECUTION_RECORDED', payload: { orderId: null, execId: 'kb-1', nativeOrderId: 'child-B', side: 'sell', base: '0.0005', quote: '49.5', price: '99000', fee: null, sourceTs: T0, receiptTs: T0, origin: 'WS_EXECUTIONS', ordRefId: 'nat-o1', nativeCumQty: '0.0005', sequence: null } });
  s = d.state(); const b = stops.find((o) => o.nativeOrderId === 'child-B'); assert.equal(s.orders[b.orderId].filledBase, '0.0005', 'the fill books against child B\'s own order'); assert.equal(s.positions.p1.protection.children[b.orderId].state, 'TRIGGERED'); assert.equal(s.positions.p1.protection.state, 'TRIGGERED'); assert.equal(s.positions.p1.soldBase, '0.0005');
});

test('R04-02. PENDING is not ACTIVE: a pending child does not count toward coverage; under-coverage past the confirmation window is PROTECTION_INVALID for the Watch; a confirmation of the second child restores ACTIVE', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'pending', clock }); const { F } = r; await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' })]);
  await r.append([F.stopIntent('sa', 'p1', { qty: '0.0005' }), F.attempt('sa'), F.result('sa', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sa' }), F.protection('p1', 'ACTIVE', { orderId: 'sa', nativeOrderId: 'nat-sa', qty: '0.0005' }), F.stopIntent('sb', 'p1', { qty: '0.0005' }), F.attempt('sb'), F.result('sb', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sb' }), F.protection('p1', 'PENDING', { orderId: 'sb', nativeOrderId: 'nat-sb', qty: '0.0005' })]);
  let s = await r.state(); assert.equal(s.positions.p1.protection.state, 'PENDING', 'R04-02: a pending child leaves the set unconfirmed'); assert.equal(s.positions.p1.protection.coverage, '0.0005');
  const ad = { kind: 'KRAKEN', stopAdmission() {}, async drain() { return {}; } }; const d = createDispatcher({ accountId: 'pending', journal: r.journal, writer: r.writer, adapter: ad, clock, specOf: () => SPEC }); await d.load(); const w = createWatch({ accountId: 'pending', dispatcher: d, adapter: ad, clock, specOf: () => SPEC, feeOf: () => TAKER_FEE });
  await w.onTick(); clock.advance(2500); const reasons = w.evaluateReasons(d.state().positions.p1); assert.ok(reasons.reasons.includes('PROTECTION_INVALID'), JSON.stringify(reasons.reasons));
  await d.commit(F.protection('p1', 'ACTIVE', { orderId: 'sb', nativeOrderId: 'nat-sb', qty: '0.0005' })); s = d.state(); assert.equal(s.positions.p1.protection.state, 'ACTIVE'); assert.equal(s.positions.p1.protection.coverage, '0.001'); assert.equal(w.evaluateReasons(s.positions.p1).reasons.includes('PROTECTION_INVALID'), false);
});

test('R04-03. over-coverage (children exceed owned base) is MISMATCH with PROTECTION_MISMATCH latched; under-coverage likewise; exact coverage is ACTIVE', async () => {
  const r = await paperAccount({ accountId: 'cover' }); const { F } = r; await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' })]);
  await r.append([F.stopIntent('sa', 'p1', { qty: '0.0007' }), F.attempt('sa'), F.result('sa', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sa' }), F.protection('p1', 'ACTIVE', { orderId: 'sa', nativeOrderId: 'nat-sa', qty: '0.0007' })]);
  let s = await r.state(); assert.equal(s.positions.p1.protection.state, 'MISMATCH', 'under-coverage'); assert.ok(s.restrictions.PROTECTION_MISMATCH);
  await r.append([F.stopIntent('sb', 'p1', { qty: '0.0003' }), F.attempt('sb'), F.result('sb', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sb' }), F.protection('p1', 'ACTIVE', { orderId: 'sb', nativeOrderId: 'nat-sb', qty: '0.0003' })]);
  s = await r.state(); assert.equal(s.positions.p1.protection.coverage, '0.001'); assert.equal(s.positions.p1.protection.state, 'ACTIVE', 'exact coverage');
  await refusedOversell(r); s = await r.state();
  await r.append(F.protection('p1', 'ACTIVE', { orderId: null, nativeOrderId: 'nat-sc', qty: '0.0002' })); s = await r.state(); assert.equal(s.positions.p1.protection.state, 'MISMATCH', 'R04-03: over-coverage would oversell'); assert.match(s.restrictions.PROTECTION_MISMATCH.reason, /above owned/);
});
async function refusedOversell(r) { await assert.rejects(r.append(r.F.stopIntent('sx', 'p1', { qty: '0.0002' })), (e) => e.detail?.code === 'OVERSELL', 'a third stop intent above the free inventory is refused'); }

test('R04-05/R04-06. an orphan child (FLAT / unknown position) is EXTERNAL_ACTIVITY + RECONCILIATION_REQUIRED, never attributed; a child below the instrument minimum is MISMATCH; an amendment names ONE child', async () => {
  const r = await paperAccount({ accountId: 'orphan' }); const { F } = r; await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1'), F.attempt('o1'), F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'f1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' })]);
  const ad = { kind: 'KRAKEN', stopAdmission() {}, async drain() { return {}; } }; const d = createDispatcher({ accountId: 'orphan', journal: r.journal, writer: r.writer, adapter: ad, clock: r.clock, specOf: () => SPEC }); await d.load();
  await d.applyAdapterEvent({ type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, state: 'ACTIVE', nativeOrderId: 'tiny', trigger: '99000', qty: '0.00001', sourceTs: T0, receiptTs: T0, reason: null } });
  let s = d.state(); assert.equal(s.positions.p1.protection.state, 'MISMATCH', 'R04-06: below the minimum is not coverage'); assert.equal(Object.values(s.orders).filter((o) => o.kind === 'PROTECTIVE_STOP').length, 0); assert.ok(s.restrictions.PROTECTION_MISMATCH);
  await d.applyAdapterEvent({ type: 'PROTECTION_STATE', payload: { positionId: 'p-unknown', orderId: null, state: 'ACTIVE', nativeOrderId: 'ghost', trigger: '99000', qty: '0.001', sourceTs: T0, receiptTs: T0, reason: null } });
  s = d.state(); assert.ok(s.externalActivity.some((x) => x.ref === 'ghost' && x.kind === 'ORDER'), 'R04-05: orphan recorded as external activity'); assert.ok(s.restrictions.RECONCILIATION_REQUIRED);
  // a FLAT position cannot adopt a child either
  const f = await paperAccount({ accountId: 'orphan-flat' }); const G = f.F; await f.append([G.hypothesis('d1'), G.decision('d1'), G.reserve('r1', 'd1'), G.position('p1', 'd1'), G.pin(), G.intent('o1', 'p1', 'r1'), G.attempt('o1'), G.result('o1', 'REJECTED'), G.release('r1', { reason: 'REJECTED_BY_VENUE', releasedCash: '100.8', releasedRisk: '4' }), G.closed('p1', 'FLAT')]);
  const d2 = createDispatcher({ accountId: 'orphan-flat', journal: f.journal, writer: f.writer, adapter: ad, clock: f.clock, specOf: () => SPEC }); await d2.load();
  await d2.applyAdapterEvent({ type: 'PROTECTION_STATE', payload: { positionId: 'p1', orderId: null, state: 'ACTIVE', nativeOrderId: 'late-child', trigger: '99000', qty: '0.001', sourceTs: T0, receiptTs: T0, reason: null } });
  const s2 = d2.state(); assert.equal(s2.positions.p1.state, 'FLAT'); assert.equal(Object.keys(s2.positions.p1.protection.children ?? {}).length, 0); assert.ok(s2.externalActivity.some((x) => x.ref === 'late-child')); assert.ok(s2.restrictions.RECONCILIATION_REQUIRED);
  // amendment names one child of a two-child set
  const two = await paperAccount({ accountId: 'amend2' }); const H = two.F; await two.append([H.hypothesis('d1'), H.decision('d1'), H.reserve('r1', 'd1'), H.position('p1', 'd1'), H.pin(), H.intent('o1', 'p1', 'r1'), H.attempt('o1'), H.result('o1', 'ACKNOWLEDGED'), H.fill('o1', 'f1'), H.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), H.stopIntent('sa', 'p1', { qty: '0.0005' }), H.attempt('sa'), H.result('sa', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sa' }), H.protection('p1', 'ACTIVE', { orderId: 'sa', nativeOrderId: 'nat-sa', qty: '0.0005' }), H.stopIntent('sb', 'p1', { qty: '0.0005' }), H.attempt('sb'), H.result('sb', 'ACKNOWLEDGED', { nativeOrderId: 'nat-sb' }), H.protection('p1', 'ACTIVE', { orderId: 'sb', nativeOrderId: 'nat-sb', qty: '0.0005' })]);
  await two.append(H.amend('p1', 'sb', 'am1', 'REQUESTED')); let t = await two.state(); assert.equal(t.positions.p1.protection.children.sb.state, 'AMEND_PENDING'); assert.equal(t.positions.p1.protection.children.sa.state, 'ACTIVE'); assert.equal(t.positions.p1.protection.state, 'AMEND_PENDING');
  await two.append(H.amend('p1', 'sb', 'am1', 'ACKNOWLEDGED')); t = await two.state(); assert.equal(t.positions.p1.protection.children.sb.trigger, '99500'); assert.equal(t.positions.p1.protection.children.sa.trigger, '99000', 'the other child is untouched'); assert.equal(t.positions.p1.protection.state, 'ACTIVE');
  await assert.rejects(two.append(H.amend('p1', 'nope', 'am2', 'REQUESTED')), (e) => e.detail?.code === 'PROTECTION_ORDER_MISMATCH');
});
