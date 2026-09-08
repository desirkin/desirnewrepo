// JUDGE / EXECUTION — the account reducer and journal law (ticket §3.1-3.3; acceptance D05, D06, C06, C12, W08 reducer
// halves). Memory journal only here (no database); the same reducer runs under PostgreSQL in judge-journal-pg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paperAccount, fakeClock, eventsFor, SAMPLE_LIMITS } from './helpers/judge.js';
import { availableCash, ownedBase, slotsUsed, ReducerRefusal } from '../execution/reducer.js';
import { JournalError, createMemoryJournal } from '../execution/journal.js';

const refused = async (fn, code) => { try { await fn(); } catch (err) { assert.equal(err.code === 'REDUCER_REFUSED' ? err.detail.code : err.code, code, err.message); return err; } assert.fail(`expected refusal ${code}`); };
async function openEntry(a, { decisionId = 'd1', reservationId = 'r1', positionId = 'p1', orderId = 'o1' } = {}) {
  const { F } = a; await a.append([F.hypothesis(decisionId), F.decision(decisionId), F.reserve(reservationId, decisionId), F.position(positionId, decisionId), F.pin(), F.intent(orderId, positionId, reservationId), F.attempt(orderId)]); return { decisionId, reservationId, positionId, orderId };
}

test('RED-01. initialization is explicit and once: USD 500 cash, no implicit deposit on a second init; every other event needs an initialized account', async () => {
  const a = await paperAccount(); const s = await a.state(); assert.equal(s.cash, '500'); assert.equal(s.initialCapital, '500'); assert.equal(s.mode, 'PAPER'); assert.deepEqual(s.limits, SAMPLE_LIMITS);
  a.clock.advance(1); await refused(() => a.append(a.F.init()), 'ACCOUNT_ALREADY_INITIALIZED');
  const j = createMemoryJournal(); await j.create('x', { accountKind: 'PAPER' }); const w = await j.acquireWriter('x'); const F = eventsFor('x', fakeClock());
  await refused(() => j.append('x', { expectedRevision: 0, writerEpoch: w.epoch, events: [F.valuation()] }), 'ACCOUNT_UNINITIALIZED');
});

test('RED-02. price-blind law: a sized decision needs its locked hypothesis; reservations need cash INSIDE the balance including fees, one per underlying, slots count pending reservations, per-position / aggregate risk caps (USD 5 / USD 10 at USD 500)', async () => {
  const a = await paperAccount(); const { F } = a;
  await refused(() => a.append(F.decision('d0')), 'PRICE_BLIND_LAW');
  await a.append([F.hypothesis('d1'), F.decision('d1')]);
  await refused(() => a.append(F.reserve('r-big', 'd1', { cashReserved: '500.01' })), 'CASH_INSUFFICIENT');
  await refused(() => a.append(F.reserve('r-risk', 'd1', { riskReserved: '5.01' })), 'RISK_PER_POSITION');
  await a.append(F.reserve('r1', 'd1', { cashReserved: '400', riskReserved: '5' })); let s = await a.state(); assert.equal(availableCash(s), '100'); assert.equal(slotsUsed(s), 1);
  await refused(() => a.append(F.reserve('r1b', 'd1')), 'RESERVATION_DUPLICATE');
  await a.append([F.hypothesis('d2', { assetId: 'BTC' }), F.decision('d2')]); await refused(() => a.append(F.reserve('r2', 'd2', { cashReserved: '50' })), 'ASSET_ALREADY_HELD');
  await a.append([F.hypothesis('d3', { assetId: 'ETH', pair: 'ETH/USD' }), F.decision('d3', { assetId: 'ETH', pair: 'ETH/USD' })]);
  await refused(() => a.append(F.reserve('r3', 'd3', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '100.01', riskReserved: '5' })), 'CASH_INSUFFICIENT');
  await refused(() => a.append(F.reserve('r3', 'd3', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '50', riskReserved: '5.0000001' })), 'RISK_PER_POSITION');
  await a.append(F.reserve('r3', 'd3', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '50', riskReserved: '5' }));
  await a.append([F.hypothesis('d4', { assetId: 'SOL', pair: 'SOL/USD' }), F.decision('d4', { assetId: 'SOL', pair: 'SOL/USD' })]);
  await refused(() => a.append(F.reserve('r4', 'd4', { assetId: 'SOL', pair: 'SOL/USD', cashReserved: '10', riskReserved: '1' })), 'RISK_AGGREGATE');
  s = await a.state(); assert.equal(availableCash(s), '50'); assert.equal(slotsUsed(s), 2);
  // release exactly once, never more than reserved
  await a.append(F.release('r3', { reason: 'EXPIRED', releasedCash: '50', releasedRisk: '5' })); a.clock.advance(1); await refused(() => a.append(F.release('r3', { reason: 'EXPIRED', releasedCash: '50', releasedRisk: '5' })), 'RESERVATION_NOT_OPEN');
  await refused(() => a.append(F.release('r1', { reason: 'EXPIRED', releasedCash: '400.01', releasedRisk: '0' })), 'RELEASE_EXCEEDS');
});

test('RED-03. entry order form: IOC marketable limit with an explicit worst price and a conditional stop below entry; no naked buy; a pin and a shell are prerequisites; one dispatch attempt per intent, never a blind resubmit', async () => {
  const a = await paperAccount(); const { F } = a; await a.append([F.hypothesis('d1'), F.decision('d1'), F.reserve('r1', 'd1'), F.position('p1', 'd1', { feedPinned: false })]);
  await refused(() => a.append(F.intent('o1', 'p1', 'r1')), 'FEED_PIN_REQUIRED'); await a.append(F.pin());
  await refused(() => a.append(F.intent('o1', 'p1', 'r1', { protection: null })), 'NAKED_ENTRY');
  await refused(() => a.append(F.intent('o1', 'p1', 'r1', { protection: { ordertype: 'stop-loss', trigger: 'last', price: '100000' } })), 'PROTECTION_ABOVE_ENTRY');
  await refused(() => a.append(F.intent('o1', 'p1', 'r1', { timeInForce: 'GTC' })), 'ENTRY_ORDER_FORM');
  await refused(() => a.append(F.intent('o1', 'p1', 'r1', { qty: '0.0011' })), 'INTENT_EXCEEDS_RESERVATION');
  await a.append(F.intent('o1', 'p1', 'r1')); await refused(() => a.append(F.intent('o1b', 'p1', 'r1')), 'RESERVATION_ALREADY_BOUND');
  await a.append(F.attempt('o1')); let s = await a.state(); assert.equal(s.orders.o1.state, 'DISPATCH_UNCERTAIN');
  await refused(() => a.append(F.attempt('o1', 'att-o1-2')), 'DISPATCH_NOT_UNSENT');
  await a.append(F.result('o1', 'UNCERTAIN')); s = await a.state(); assert.equal(s.orders.o1.state, 'DISPATCH_UNCERTAIN', 'uncertain stays uncertain');
  await refused(() => a.append(F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '100.8', releasedRisk: '4' })), 'RELEASE_WHILE_ORDER_OPEN');
});

test('RED-04 (D05/D06/C06). fills: exact cash / base conservation, execution-id dedup vs conflicting identity, cumulative totals are checks not fills, late fill after cancel reconciles once, FILLED status without executions is refused, oversell refused', async () => {
  const a = await paperAccount(); const { F } = a; await openEntry(a);
  await a.append([F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'x1', { base: '0.0005', quote: '50', fee: { asset: 'USD', amount: '0.4' } })]);
  let s = await a.state(); assert.equal(s.cash, '449.6'); assert.equal(s.positions.p1.confirmedBase, '0.0005'); assert.equal(s.orders.o1.state, 'PARTIALLY_FILLED'); assert.equal(s.positions.p1.state, 'OPEN'); assert.ok(s.positions.p1.firstFillTs);
  a.clock.advance(5); await refused(() => a.append(F.fill('o1', 'x1', { base: '0.0005', quote: '50', fee: { asset: 'USD', amount: '0.4' } })), 'DUPLICATE_EXECUTION');
  await refused(() => a.append(F.fill('o1', 'x1', { base: '0.0004', quote: '40', fee: { asset: 'USD', amount: '0.4' } })), 'EXECUTION_IDENTITY_CONFLICT');
  await refused(() => a.append(F.orderState('o1', 'FILLED')), 'FILLED_WITHOUT_EXECUTIONS');
  await refused(() => a.append(F.orderState('o1', 'PARTIALLY_FILLED', { nativeCumQty: '0.0007' })), 'CUM_QTY_MISMATCH');
  await refused(() => a.append(F.fill('o1', 'x2', { base: '0.0006', quote: '60' })), 'OVERFILL');
  await a.append([F.orderState('o1', 'CANCELLED', { nativeCumQty: '0.0005' })]); s = await a.state(); assert.equal(s.orders.o1.state, 'CANCELLED'); assert.equal(s.positions.p1.pendingEntryBase, '0');
  // a late fill after cancellation is venue truth: recorded exactly once, order stays CANCELLED with a late-fill count
  await a.append(F.fill('o1', 'x3', { base: '0.0002', quote: '20', fee: { asset: 'USD', amount: '0.16' } })); s = await a.state(); assert.equal(s.positions.p1.confirmedBase, '0.0007'); assert.equal(s.orders.o1.state, 'CANCELLED'); assert.equal(s.orders.o1.lateFills, 1); assert.equal(s.cash, '429.44');
  a.clock.advance(5); await refused(() => a.append(F.fill('o1', 'x3', { base: '0.0002', quote: '20', fee: { asset: 'USD', amount: '0.16' } })), 'DUPLICATE_EXECUTION');
  await a.append(F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '30.08', releasedRisk: '1.2' }));
  // fee-in-base reduces owned inventory; a sell above owned base is refused; partial exit + realized P&L
  await a.append(F.fill('o1', 'x4', { base: '0.0001', quote: '10', fee: { asset: 'BTC', amount: '0.00000001' } })); s = await a.state(); assert.equal(ownedBase(s.positions.p1), '0.00079999');
  await refused(() => a.append(F.sellIntent('s1', 'p1', { qty: '0.0008' })), 'OVERSELL');
  await a.append([F.sellIntent('s1', 'p1', { qty: '0.0004' }), F.attempt('s1'), F.result('s1', 'ACKNOWLEDGED'), F.fill('s1', 'x5', { side: 'sell', base: '0.0004', quote: '41', fee: { asset: 'USD', amount: '0.328' } })]);
  s = await a.state(); assert.equal(s.orders.s1.state, 'FILLED'); assert.equal(ownedBase(s.positions.p1), '0.00039999'); assert.equal(s.cash, '460.112'); assert.equal(s.positions.p1.exitQuote, '41');
  assert.ok(s.positions.p1.realizedPnl !== null);
  await refused(() => a.append(F.closed('p1', 'FLAT')), 'RESIDUAL_MISMATCH'); await refused(() => a.append(F.closed('p1', 'FLAT', { residualBase: '0.00039999' })), 'NOT_FLAT');
});

test('RED-05 (W08 reducer half). FLAT needs zero residual, no open orders and no orphan protection; competing sells are refused while a stop may sell the same inventory; dust is explicit; a write-off needs an owner', async () => {
  const a = await paperAccount(); const { F } = a; await openEntry(a);
  await a.append([F.result('o1', 'ACKNOWLEDGED'), F.fill('o1', 'x1'), F.release('r1', { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }), F.stopIntent('st1', 'p1'), F.attempt('st1'), F.result('st1', 'ACKNOWLEDGED'), F.protection('p1', 'ACTIVE', { orderId: 'st1', nativeOrderId: 'nat-st1' })]);
  let s = await a.state(); assert.equal(s.positions.p1.protection.state, 'ACTIVE'); assert.equal(s.orders.o1.state, 'FILLED');
  await refused(() => a.append(F.sellIntent('s1', 'p1')), 'COMPETING_SELL');
  await refused(() => a.append(F.closed('p1', 'FLAT', { residualBase: '0.001' })), 'NOT_FLAT');
  await a.append([F.ev('CANCEL_REQUESTED', { orderId: 'st1', attemptId: 'c1', ts: a.clock.now() })]); await refused(() => a.append(F.ev('CANCEL_REQUESTED', { orderId: 'st1', attemptId: 'c2', ts: a.clock.now() })), 'CANCEL_PENDING');
  await a.append(F.ev('CANCEL_RESULT', { orderId: 'st1', attemptId: 'c1', outcome: 'CANCELLED', reason: null, receiptTs: a.clock.now() })); s = await a.state(); assert.equal(s.positions.p1.protection.state, 'CANCELLED'); assert.equal(s.orders.st1.state, 'CANCELLED');
  await a.append([F.sellIntent('s1', 'p1', { qty: '0.00099' }), F.attempt('s1'), F.result('s1', 'ACKNOWLEDGED'), F.fill('s1', 'x2', { side: 'sell', base: '0.00099', quote: '99.5', fee: { asset: 'USD', amount: '0.8' } })]);
  s = await a.state(); assert.equal(ownedBase(s.positions.p1), '0.00001');
  await refused(() => a.append(F.closed('p1', 'FLAT', { residualBase: '0.00001' })), 'NOT_FLAT');
  await refused(() => a.append(F.ev('DUST_STATE', { positionId: 'p1', base: '0.00001', state: 'WRITTEN_OFF', ownerRef: null, ts: a.clock.now() })), 'OWNER_WRITEOFF_REQUIRED');
  await a.append(F.closed('p1', 'DUST_UNRESOLVED', { residualBase: '0.00001' })); s = await a.state(); assert.equal(s.positions.p1.state, 'DUST_UNRESOLVED'); assert.equal(slotsUsed(s), 0, 'dust does not hold a slot but stays visible');
  await refused(() => a.append(F.pin('XBT/USD', 'RELEASE')), 'PIN_HELD');
});

test('RED-06 (C12). flow-neutral drawdown: start 500, lose 50 -> dd 10%; a verified deposit of 50 keeps performance equity 450 and dd 10%; withdrawal without loss keeps dd 0; breach latches DAILY_LOSS for the session and PEAK_DRAWDOWN until owner clear; recovery does not unlatch', async () => {
  const a = await paperAccount(); const { F } = a;
  await refused(() => a.append(F.valuation({ cashComponent: '450', equity: '450' })), 'VALUATION_CASH_MISMATCH');
  await a.append(F.valuation({ cashComponent: '500', liquidationComponent: '-50', equity: '450' })); let s = await a.state(); assert.equal(s.performance.riskPerformanceEquity, '450'); assert.equal(s.performance.highWater, '500'); assert.equal(s.performance.drawdown, 0.1); assert.ok(s.restrictions.PEAK_DRAWDOWN); assert.ok(s.restrictions.DAILY_LOSS);
  await a.append(F.flow('f1', 'DEPOSIT', '50')); await a.append(F.valuation({ cashComponent: '550', liquidationComponent: '-50', equity: '500' })); s = await a.state(); assert.equal(s.externalFlows, '50'); assert.equal(s.performance.riskPerformanceEquity, '450'); assert.equal(s.performance.drawdown, 0.1, 'a deposit does not cure drawdown');
  await a.append(F.valuation({ cashComponent: '550', liquidationComponent: '0', equity: '550' })); s = await a.state(); assert.equal(s.performance.drawdown, 0); assert.ok(s.restrictions.PEAK_DRAWDOWN, 'an observed breach latches even if the next valuation recovers'); assert.ok(s.restrictions.DAILY_LOSS, 'daily loss stays latched through its session');
  await refused(() => a.append(F.restriction('DAILY_LOSS', 'CLEAR')), 'DAILY_LOSS_LATCHED'); await refused(() => a.append(F.restriction('PEAK_DRAWDOWN', 'CLEAR')), 'OWNER_CLEAR_REQUIRED');
  await a.append(F.restriction('PEAK_DRAWDOWN', 'CLEAR', { ownerRef: 'owner-test' })); s = await a.state(); assert.equal(s.restrictions.PEAK_DRAWDOWN, undefined);
  await a.append(F.valuation({ cashComponent: '550', liquidationComponent: '0', equity: '550', sessionDate: '2026-09-09' })); s = await a.state(); assert.equal(s.restrictions.DAILY_LOSS, undefined, 'a new session opens a new allowance'); assert.equal(s.performance.session.openingEquity, '550');
  const b = await paperAccount(); await b.append(b.F.flow('w1', 'WITHDRAWAL', '50')); await b.append(b.F.valuation({ cashComponent: '450', liquidationComponent: '0', equity: '450' })); const sb = await b.state(); assert.equal(sb.externalFlows, '-50'); assert.equal(sb.performance.riskPerformanceEquity, '500'); assert.equal(sb.performance.drawdown, 0); assert.equal(sb.restrictions.PEAK_DRAWDOWN, undefined);
  await refused(() => b.append(b.F.flow('w2', 'WITHDRAWAL', '451')), 'WITHDRAWAL_EXCEEDS_CASH');
  await b.append(b.F.valuation({ ts: b.clock.now() + 1, cashComponent: '450', liquidationComponent: null, equity: null, unknown: true, reason: 'missing mark' })); await b.append([b.F.hypothesis('d1'), b.F.decision('d1')]); await refused(() => b.append(b.F.reserve('r1', 'd1')), 'VALUATION_UNKNOWN');
});

test('RED-07. restrictions and modes: KILL moves to REDUCE_ONLY and blocks reservations; CAGE blocks additions; VETO scopes; LIVE modes need a LIVE account, explicit owner limits and an active LIVE_ARM; a canary and ordinary arm are exclusive; replay verifies the journal chain', async () => {
  const a = await paperAccount(); const { F } = a; await a.append([F.hypothesis('d1'), F.decision('d1')]);
  await a.append(F.restriction('CAGE')); await refused(() => a.append(F.reserve('r1', 'd1')), 'ENTRY_RESTRICTED'); await a.append(F.restriction('CAGE', 'CLEAR'));
  await a.append(F.restriction('KILL')); let s = await a.state(); assert.equal(s.mode, 'REDUCE_ONLY'); await refused(() => a.append(F.mode('REDUCE_ONLY', 'PAPER')), 'KILLED'); await refused(() => a.append(F.restriction('KILL', 'CLEAR')), 'OWNER_CLEAR_REQUIRED');
  await a.append(F.restriction('KILL', 'CLEAR', { ownerRef: 'owner-test' })); await a.append(F.mode('REDUCE_ONLY', 'PAPER'));
  await refused(() => a.append(F.mode('PAPER', 'LIVE_ARMED')), 'MODE_KIND_MISMATCH'); await refused(() => a.append(F.authorized('auth1')), 'AUTHORIZATION_KIND_MISMATCH');
  const live = await paperAccount({ accountId: 'live-test', init: { accountKind: 'LIVE' } }); const L = live.F; s = await live.state(); assert.equal(s.mode, 'LIVE_UNARMED');
  await refused(() => live.append(L.authorized('auth0', { limits: null })), 'OWNER_LIMITS_REQUIRED'); await refused(() => live.append(L.authorized('auth0', { keyFingerprint: null })), 'KEY_BINDING_REQUIRED');
  await refused(() => live.append(L.mode('LIVE_UNARMED', 'LIVE_ARMED')), 'ARM_REQUIRED');
  await live.append(L.authorized('auth1')); await refused(() => live.append(L.authorized('can1', { kind: 'CANARY', canary: { pair: 'XBT/USD', maxBuyConsiderationWithFees: '10', maxDurationMs: 600000, lossAcknowledged: true } })), 'AUTHORIZATION_EXCLUSIVE');
  await live.append(L.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId: 'auth1' })); s = await live.state(); assert.equal(s.mode, 'LIVE_ARMED');
  live.clock.advance(3_600_001); await live.append([L.hypothesis('d1'), L.decision('d1')]); await refused(() => live.append(L.reserve('r1', 'd1')), 'ARM_EXPIRED');
  await live.append(L.ev('AUTHORIZATION_ENDED', { authorizationId: 'auth1', reason: 'EXPIRED', ts: live.clock.now() })); s = await live.state(); assert.equal(s.mode, 'REDUCE_ONLY', 'expiry stops additions while exits stay managed');
  const v = await live.journal.replayVerify('live-test'); assert.equal(v.ok, true, v.reason); assert.ok(v.events >= 5);
  // a stale writer epoch cannot commit; a revision conflict refuses
  const other = createMemoryJournal(); await other.create('z', { accountKind: 'PAPER' }); const w1 = await other.acquireWriter('z'); assert.equal(await other.acquireWriter('z'), null, 'one writer at a time'); await w1.release(); const w2 = await other.acquireWriter('z');
  const Z = eventsFor('z', fakeClock()); await assert.rejects(other.append('z', { expectedRevision: 0, writerEpoch: w1.epoch, events: [Z.init()] }), (e) => e.code === 'EPOCH_FENCED'); await other.append('z', { expectedRevision: 0, writerEpoch: w2.epoch, events: [Z.init()] }); await assert.rejects(other.append('z', { expectedRevision: 0, writerEpoch: w2.epoch, events: [Z.valuation()] }), (e) => e.code === 'REVISION_CONFLICT');
});
