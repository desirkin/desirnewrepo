// CLOSEOUT R01 — the current entry authority is checked IMMEDIATELY before the actual send, after every queue wait and
// await, on the state the journal holds at that instant; an owned protective reduction has its own (smaller) law.
// Production callers under test: execution/dispatcher.js dispatchEntry, judge/judge.js decide (shared entryPermission),
// execution/reducer.js RESERVATION_OPENED (allocation), judge/risk.js (allocation-bounded size), execution/journal.js
// (lease), watch/watch.js advanceExit (reduction). Every venue is a local double; nothing here reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createWatch } from '../watch/watch.js';
import { riskBudgetFor, admitCandidate } from '../judge/risk.js';
import { feeContract, instrumentSpec } from '../execution/contract.js';
import { paperAccount, fakeClock, eventsFor, SPEC, TAKER_FEE, T0, SAMPLE_LIMITS, HEX, canaryCompleted } from './helpers/judge.js';
import { readFileSync } from 'node:fs';

const CANARY = { pair: 'XBT/USD', maxBuyConsiderationWithFees: '150', maxDurationMs: 600_000, lossAcknowledged: true };
// a counting venue double: records every NEW-entry transport call and every reduction; never a fill unless scripted
function venue({ kind = 'PAPER', entry = 'ACKNOWLEDGED' } = {}) {
  const calls = { entries: [], reductions: [], cancels: 0, admission: true };
  return { kind, calls, stopAdmission() { calls.admission = false; }, async drain() { return {}; }, async submitEntryWithProtection({ intent }) { calls.entries.push(intent.orderId); return entry === 'UNCERTAIN' ? { outcome: 'UNCERTAIN', nativeOrderId: null, reason: 'scripted timeout', guaranteesNoAcceptance: false } : { outcome: 'ACKNOWLEDGED', nativeOrderId: `nat-${intent.orderId}`, reason: null, guaranteesNoAcceptance: false }; }, async closeResidual({ intent }) { calls.reductions.push({ orderId: intent.orderId, qty: intent.qty }); return { outcome: 'ACKNOWLEDGED', nativeOrderId: `sell-${intent.orderId}`, reason: null, guaranteesNoAcceptance: false }; }, async cancelOwnedOrder() { calls.cancels += 1; return { outcome: 'CANCELLED', reason: null }; }, async reconcile() { return { outcome: 'COMPLETE', unmatched: 0, pageIncomplete: false }; }, async amendProtection() { return { outcome: 'FAILED', confirmedTrigger: null, reason: 'none' }; } };
}
// an initialized account with an unsent entry intent (shell, pin, open reservation) and a dispatcher over the counting venue
async function rig({ accountId = 'auth', init = {}, adapter = null, specOf = () => SPEC, feeOf = () => TAKER_FEE, controls = null, authority = null, feed = null, before = null, clock = fakeClock() } = {}) {
  const r = await paperAccount({ accountId, init, clock }); const { F } = r; const ad = adapter ?? venue();
  if (before) await before(r);
  await r.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1'), F.pin(), F.intent('o1', 'p1', 'r1')]);
  const d = createDispatcher({ accountId: r.accountId, journal: r.journal, writer: r.writer, adapter: ad, clock: r.clock, specOf, feeOf, controls, authority, feed }); await d.load();
  return { ...r, d, ad };
}
const live = (r) => r.append([...canaryCompleted(r.F, r.clock), r.F.authorized('arm1', { allocationCeiling: '500' }), r.F.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'arm1' })]);

test('R01-01. KILL latched after the durable intent and before the send: deferred SAFETY work resumes, the dispatcher sends NOTHING (zero transport calls), the unsent order is CANCELLED and its reservation released', async () => {
  const r = await rig(); let release; const gate = new Promise((res) => { release = res; });
  const blocker = r.d.enqueue('SAFETY', () => gate); const deferred = r.d.enqueue('SAFETY', () => r.d.dispatchEntry('o1'));
  await r.d.commit(r.F.restriction('KILL')); release(); await blocker; const res = await deferred;
  assert.equal(r.ad.calls.entries.length, 0, 'R01-01: zero new-entry transport calls after KILL'); assert.equal(res.sent, false); assert.match(res.reason, /KILL/);
  const s = r.d.state(); assert.equal(s.orders.o1.state, 'CANCELLED'); assert.equal(s.reservations.r1.state, 'RELEASED'); assert.equal(s.reservations.r1.releaseReason, 'REFUSED_AT_REVALIDATION'); assert.equal(M.toStatistic(s.cash), 500); assert.equal(s.positions.p1.state, 'SHELL');
});

test('R01-02. the LIVE authorization expires between the durable intent and the send: zero sends; a still-active authorization sends exactly once', async () => {
  const r = await rig({ accountId: 'auth-live', init: { accountKind: 'LIVE' }, before: live }); r.clock.advance(3_600_001); // past expiresTs
  const res = await r.d.dispatchEntry('o1'); assert.equal(r.ad.calls.entries.length, 0, 'R01-02: expired authorization sends nothing'); assert.match(res.reason, /ARM_REQUIRED|ARM_EXPIRED/); assert.equal(r.d.state().orders.o1.state, 'CANCELLED');
  const ok = await rig({ accountId: 'auth-live-ok', init: { accountKind: 'LIVE' }, before: live }); await ok.d.dispatchEntry('o1'); assert.deepEqual(ok.ad.calls.entries, ['o1'], 'positive control: an active LIVE_ARM authorization sends once');
});

test('R01-03. release / key / policy binding changed since the authorization: the dispatcher context refuses the send (KEY / POLICY / RELEASE binding), the matching binding sends', async () => {
  for (const [binding, code] of [[{ keyFingerprint: 'kf-other' }, 'KEY_BINDING_CHANGED'], [{ policyDigest: 'b'.repeat(64) }, 'POLICY_BINDING_CHANGED'], [{ releaseDigest: 'e'.repeat(64) }, 'RELEASE_BINDING_CHANGED'], [{ codeDigest: 'd'.repeat(64) }, 'CODE_BINDING_CHANGED']]) {
    const r = await rig({ accountId: `auth-bind-${code}`, init: { accountKind: 'LIVE' }, before: live, authority: { runMode: 'LIVE_ARMED', binding: { keyFingerprint: 'kf-abc', policyDigest: 'a'.repeat(64), releaseDigest: HEX('f'), codeDigest: HEX('c'), ...binding } } });
    const res = await r.d.dispatchEntry('o1'); assert.equal(r.ad.calls.entries.length, 0, `R01-03 ${code}: zero sends`); assert.match(res.reason, new RegExp(code));
  }
  const ok = await rig({ accountId: 'auth-bind-ok', init: { accountKind: 'LIVE' }, before: live, authority: { runMode: 'LIVE_ARMED', binding: { keyFingerprint: 'kf-abc', policyDigest: 'a'.repeat(64), releaseDigest: HEX('f'), codeDigest: HEX('c') } } }); await ok.d.dispatchEntry('o1'); assert.deepEqual(ok.ad.calls.entries, ['o1']);
});

test('R01-04. the allocation ceiling is applied transactionally by the reducer: an armed ceiling of USD 10 (LESS than the funded USD 500 cash) refuses a USD 100.8 reservation; a ceiling of 200 admits it; with reinvestment NONE realized gains are not redeployable', async () => {
  const r = await paperAccount({ accountId: 'alloc', init: { accountKind: 'LIVE' } }); const { F } = r;
  await r.append([...canaryCompleted(F, r.clock), F.authorized('arm1', { allocationCeiling: '10' }), F.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'arm1' }), F.hypothesis('d1'), F.decision('d1')]);
  assert.equal((await r.state()).cash, '500', 'funded cash exceeds the ceiling: the ceiling must bind');
  await assert.rejects(r.append(F.reserve('r1', 'd1')), (e) => e.detail?.code === 'ALLOCATION_EXCEEDED', 'R01-04: reservation above the remaining allocation refused');
  const ok = await paperAccount({ accountId: 'alloc-ok', init: { accountKind: 'LIVE' } });
  await ok.append([...canaryCompleted(ok.F, ok.clock), ok.F.authorized('arm1', { allocationCeiling: '200' }), ok.F.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'arm1' }), ok.F.hypothesis('d1'), ok.F.decision('d1'), ok.F.reserve('r1', 'd1')]);
  assert.equal((await ok.state()).reservations.r1.state, 'OPEN', 'positive control: inside the ceiling');
  await assert.rejects(ok.append([ok.F.hypothesis('d2', { assetId: 'ETH', pair: 'ETH/USD' }), ok.F.decision('d2', { assetId: 'ETH', pair: 'ETH/USD' }), ok.F.reserve('r2', 'd2', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '100' })]), (e) => e.detail?.code === 'ALLOCATION_EXCEEDED', 'open reservations count against the ceiling (100.8 + 100 > 200)');
  // reinvestment NONE: a realized gain does not widen the deployable amount (gain 10 on a 200 ceiling -> 190 deployable)
  const g = await paperAccount({ accountId: 'alloc-gain', init: { accountKind: 'LIVE' } }); const G = g.F;
  await g.append([...canaryCompleted(G, g.clock), G.authorized('arm1', { allocationCeiling: '200', reinvestment: 'NONE' }), G.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'arm1' }), G.hypothesis('d1'), G.decision('d1'), G.reserve('r1', 'd1', { cashReserved: '100.8' }), G.position('p1', 'd1'), G.pin(), G.intent('o1', 'p1', 'r1'), G.attempt('o1'), G.result('o1', 'ACKNOWLEDGED'), G.fill('o1', 'f1', { fee: { asset: 'USD', amount: '0' } }), G.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0.8', releasedRisk: '0' }), G.sellIntent('s1', 'p1'), G.attempt('s1'), G.result('s1', 'ACKNOWLEDGED'), G.fill('s1', 'x1', { side: 'sell', base: '0.001', quote: '110', price: '110000', fee: { asset: 'USD', amount: '0' } }), G.closed('p1')]);
  let s = await g.state(); assert.equal(s.realized.pnl, '10'); assert.equal(s.cash, '510');
  await g.append([G.hypothesis('d2', { assetId: 'ETH', pair: 'ETH/USD' }), G.decision('d2', { assetId: 'ETH', pair: 'ETH/USD' })]);
  await assert.rejects(g.append(G.reserve('r2', 'd2', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '195' })), (e) => e.detail?.code === 'ALLOCATION_EXCEEDED', 'NONE: 195 > 190 deployable');
  await g.append(G.reserve('r2', 'd2', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '190' })); s = await g.state(); assert.equal(s.reservations.r2.state, 'OPEN');
});

test('R01-05. the size search sees the smaller legal amount: the risk budget cash is the minimum of available cash and the remaining allocation (never the whole funded cash), and admission names ALLOCATION as the binding constraint', async () => {
  const r = await paperAccount({ accountId: 'alloc-size', init: { accountKind: 'LIVE' } }); await r.append([...canaryCompleted(r.F, r.clock), r.F.authorized('arm1', { allocationCeiling: '10' }), r.F.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'arm1' })]);
  const s = await r.state(); const b = riskBudgetFor({ state: s, limits: s.limits, clusterId: 'BTC' }); assert.equal(b.cash, '10', 'R01-05: budget cash bounded by the remaining allocation'); assert.equal(b.caps.allocationRemaining, '10');
  const a = admitCandidate({ state: s, candidate: { assetId: 'BTC', clusterId: 'BTC', entryCashOut: '50', riskUsd: '1' }, limits: s.limits }); assert.equal(a.ok, false); assert.ok(a.reasons.includes('ALLOCATION_EXCEEDED'), JSON.stringify(a.reasons)); assert.ok(a.binding.includes('ALLOCATION'));
  const paper = await paperAccount({ accountId: 'alloc-paper' }); const ps = await paper.state(); assert.equal(riskBudgetFor({ state: ps, limits: ps.limits, clusterId: 'BTC' }).cash, '500', 'no authorization bounds a paper account: cash rules');
});

test('R01-06. a released / lost writer closes the sender: the journal fences the released epoch at once (before any successor), the dispatcher marks WRITER_LOST and stops adapter admission, a later dispatch sends nothing', async () => {
  const r = await rig({ accountId: 'lease' }); await r.writer.release(); assert.equal(r.writer.held(), false);
  await assert.rejects(r.d.commit(r.F.restriction('CAGE')), (e) => e.code === 'EPOCH_FENCED' || e.code === 'LOCK_LOST' || e.code === 'WRITER_LOST', 'R01-06: a released epoch cannot commit');
  assert.equal(r.d.writerLost(), true); assert.equal(r.ad.calls.admission, false, 'the sender is closed'); assert.equal(r.d.state().restrictions.CAGE, undefined, 'nothing was journalled');
  await assert.rejects(r.d.dispatchEntry('o1'), (e) => e.code === 'WRITER_LOST' || e.code === 'EPOCH_FENCED'); assert.equal(r.ad.calls.entries.length, 0, 'zero sends after the lease is gone');
  // direct journal law: the released epoch is refused even though no successor exists yet
  await assert.rejects(r.journal.append(r.accountId, { expectedRevision: r.d.revision(), writerEpoch: r.writer.epoch, events: [r.F.restriction('CAGE')] }), (e) => e.code === 'EPOCH_FENCED' || e.code === 'LOCK_LOST');
});

test('R01-08. an already-sent ambiguous liability keeps its reservation: an UNCERTAIN send stays DISPATCH_UNCERTAIN with the reservation OPEN (never refunded), and a second dispatch attempt is refused', async () => {
  const r = await rig({ accountId: 'uncertain', adapter: venue({ entry: 'UNCERTAIN' }) }); const res = await r.d.dispatchEntry('o1'); assert.equal(res.outcome, 'UNCERTAIN'); assert.equal(r.ad.calls.entries.length, 1);
  const s = r.d.state(); assert.equal(s.orders.o1.state, 'DISPATCH_UNCERTAIN'); assert.equal(s.reservations.r1.state, 'OPEN', 'R01-08: the ambiguous liability is retained');
  await assert.rejects(r.d.commit(r.F.release('r1', { reason: 'EXPIRED', releasedCash: '100.8', releasedRisk: '4' })), (e) => e.detail?.code === 'RELEASE_WHILE_ORDER_OPEN');
  await assert.rejects(r.d.dispatchEntry('o1'), (e) => e.code === 'NOT_UNSENT'); assert.equal(r.ad.calls.entries.length, 1, 'never a blind resend');
});

test('R01-09/R01-10/R01-11/R01-12. spec changed or halted, fee changed / expired, no fresh usable quote, reservation no longer covering: each refuses the send on the current state; the unchanged inputs send once', async () => {
  const halted = instrumentSpec({ ...SPEC, status: 'cancel_only', specDigest: undefined }); const otherSpec = instrumentSpec({ ...SPEC, priceIncrement: '0.5', specDigest: undefined });
  for (const [spec, code] of [[halted, 'INSTRUMENT_CANCEL_ONLY'], [otherSpec, 'SPEC_CHANGED'], [null, 'SPEC_UNKNOWN']]) { const r = await rig({ accountId: `spec-${code}`, specOf: () => spec }); const res = await r.d.dispatchEntry('o1'); assert.equal(r.ad.calls.entries.length, 0, `R01-09 ${code}`); assert.match(res.reason, new RegExp(code)); }
  const otherFee = feeContract({ ...TAKER_FEE, rate: '0.009', feeDigest: undefined }); const expiredFee = feeContract({ ...TAKER_FEE, expiresTs: T0 - 1, feeDigest: undefined });
  for (const [fee, code] of [[otherFee, 'FEE_CHANGED'], [expiredFee, 'FEE_EXPIRED'], [null, 'FEE_UNKNOWN']]) { const r = await rig({ accountId: `fee-${code}`, feeOf: () => fee }); const res = await r.d.dispatchEntry('o1'); assert.equal(r.ad.calls.entries.length, 0, `R01-10 ${code}`); assert.match(res.reason, new RegExp(code)); }
  // R01-11: a feed whose book for the pair is stale (older than the usable age) or absent refuses; a fresh synced book sends
  const clock = fakeClock(); const feed = createExecutionFeed({ clock: clock.now }); feed.admit('XBT/USD', { priority: 'PENDING', reason: 'test' }); feed.onConnect(clock.now());
  const stale = await rig({ accountId: 'quote-stale', feed, clock }); const res1 = await stale.d.dispatchEntry('o1'); assert.equal(stale.ad.calls.entries.length, 0, 'R01-11: no book at all'); assert.match(res1.reason, /QUOTE_NOT_FRESH/);
  feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: [{ price: '100010.0', qty: '5' }], bids: [{ price: '99990.0', qty: '5' }] }] }), clock.now());
  const fresh = await rig({ accountId: 'quote-fresh', feed, clock }); await fresh.d.dispatchEntry('o1'); assert.deepEqual(fresh.ad.calls.entries, ['o1'], 'a fresh synced book sends');
  clock.advance(5000); const aged = await rig({ accountId: 'quote-aged', feed, clock }); const res3 = await aged.d.dispatchEntry('o1'); assert.equal(aged.ad.calls.entries.length, 0, 'R01-11: a 5 s old book is not a fresh quote'); assert.match(res3.reason, /QUOTE_NOT_FRESH/);
  // R01-12: the reservation released / consumed under the intent (an owner release of an unsent intent) refuses the send
  const r = await rig({ accountId: 'res-gone' }); await r.d.commit([r.F.orderState('o1', 'CANCELLED', { nativeCumQty: '0', reason: 'owner cancelled the unsent intent' }), r.F.release('r1', { reason: 'CANCELLED_UNSENT', releasedCash: '100.8', releasedRisk: '4' })]);
  await assert.rejects(r.d.dispatchEntry('o1'), (e) => e.code === 'NOT_UNSENT'); assert.equal(r.ad.calls.entries.length, 0, 'R01-12');
});

test('R01-13. NEW-exposure authority is separate from owned protective reductions: under KILL the entry is refused (zero entry sends) while the Watch flattens the OWNED inventory through exactly one protective sell sized to the owned residual; a reduction above owned base is refused', async () => {
  const clock = fakeClock(); const r = await paperAccount({ accountId: 'reduce2', clock }); const ad = venue({ kind: 'KRAKEN' });
  await r.append([r.F.hypothesis('d1'), r.F.decision('d1'), r.F.reserve('r1', 'd1'), r.F.position('p1', 'd1'), r.F.pin(), r.F.intent('o1', 'p1', 'r1'), r.F.attempt('o1'), r.F.result('o1', 'ACKNOWLEDGED'), r.F.fill('o1', 'f1'), r.F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), r.F.stopIntent('st1', 'p1'), r.F.attempt('st1'), r.F.result('st1', 'ACKNOWLEDGED'), r.F.protection('p1', 'ACTIVE', { orderId: 'st1', nativeOrderId: 'nat-st1' }), r.F.r('p1', 'FINAL')]);
  await r.append([r.F.hypothesis('d2', { assetId: 'ETH', pair: 'ETH/USD' }), r.F.decision('d2', { assetId: 'ETH', pair: 'ETH/USD', sizing: { q: '0.01', entryLimitPrice: '4000', entryCashOut: '40.4', riskUsd: '1', bufferedScenarioNetProfit: '1' } }), r.F.reserve('r2', 'd2', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '50', riskReserved: '1' }), r.F.position('p2', 'd2', { assetId: 'ETH', pair: 'ETH/USD' }), r.F.pin('ETH/USD'), r.F.intent('o2', 'p2', 'r2', { pair: 'ETH/USD', qty: '0.01', limitPrice: '4000', protection: { ordertype: 'stop-loss', trigger: 'last', price: '3900' } })]);
  const ctl = { kill: true, cage: false, vetoes: [] }; const d = createDispatcher({ accountId: 'reduce2', journal: r.journal, writer: r.writer, adapter: ad, clock, specOf: () => SPEC, controls: () => ctl }); await d.load();
  const res = await d.dispatchEntry('o2'); assert.equal(ad.calls.entries.length, 0, 'R01-13: zero NEW-entry sends under the owner KILL control'); assert.match(res.reason, /KILL/); assert.equal(d.state().orders.o2.state, 'CANCELLED');
  const w = createWatch({ accountId: 'reduce2', dispatcher: d, adapter: ad, clock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => ctl });
  await w.onTick(); await w.onTick(); await d.idle(); // KILL: cancel the child (acknowledged), reconcile, sell the owned residual
  for (let i = 0; i < 4; i += 1) { clock.advance(250); await w.onTick(); await d.idle(); }
  assert.equal(ad.calls.reductions.length, 1, `R01-13: exactly one owned protective reduction (${JSON.stringify(w.positions()[0].exit)})`); assert.equal(ad.calls.reductions[0].qty, '0.001', 'sized to the owned residual'); assert.equal(d.state().restrictions.KILL !== undefined, true);
  const { reductionAuthority } = await import('../execution/authority.js'); const s = d.state(); const sellId = ad.calls.reductions[0].orderId;
  assert.equal(reductionAuthority(s, { positionId: 'p1', side: 'sell', qty: '0.002', orderId: 'x' }).reasons[0], 'OVERSELL', 'a reduction above owned base is never authorized'); assert.equal(reductionAuthority(s, { positionId: 'p1', side: 'sell', qty: '0.001', orderId: sellId }).ok, true, 'the open sell itself is the owned reduction');
  assert.equal(reductionAuthority(s, { positionId: 'p1', side: 'sell', qty: '0.0001', orderId: 'y' }).reasons[0], 'OVERSELL', 'inventory locked by the open sell is not available twice');
});

test('R01-14. ONE shared law: the Judge pre-commit permission and the dispatcher pre-send check both import entryPermission / entryAuthority from execution/authority.js (static), and the dispatcher exposes the current authority of an unsent intent', async () => {
  const judge = readFileSync('judge/judge.js', 'utf8'); const dispatcher = readFileSync('execution/dispatcher.js', 'utf8'); const watch = readFileSync('watch/watch.js', 'utf8');
  assert.match(judge, /from '\.\.\/execution\/authority\.js'/); assert.match(judge, /entryPermission\(/); assert.match(dispatcher, /from '\.\/authority\.js'/); assert.match(dispatcher, /entryAuthority\(/); assert.match(watch, /reductionAuthority\(/);
  const r = await rig({ accountId: 'shared' }); assert.equal(r.d.authorityOf('o1').ok, true); await r.d.commit(r.F.restriction('CAGE')); assert.deepEqual(r.d.authorityOf('o1').reasons, ['CAGE']);
});
