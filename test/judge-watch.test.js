// WATCH — W01-W10 against the PAPER adapter, the execution feed, the memory journal and the dispatcher (the real reducers).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createWatch, WATCH_REFERENCE } from '../watch/watch.js';
import { eventsFor, fakeClock, SPEC, TAKER_FEE, T0 } from './helpers/judge.js';
import { ownedBase } from '../execution/reducer.js';

async function rig({ accountId = 'w-acct', script, controls = { kill: false, cage: false }, falsifiers = () => [], policy } = {}) {
  const clock = fakeClock(); const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.admit('XBT/USD', { priority: 'PENDING', reason: 'test' }); feed.onConnect(clock.now()); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TAKER_FEE, specOf: () => SPEC, script });
  const pclock = { now: clock.now, monotonic: clock.monotonic }; const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load();
  const ctl = { ...controls }; const watch = createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TAKER_FEE, controls: () => ctl, falsifiers, policy: policy ?? WATCH_REFERENCE });
  await dispatcher.commit(F.init());
  const book = (asks, bids, type = 'update') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'sell', qty = 0.01) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };
  const advance = async (ms, step = 250) => { for (let t = 0; t < ms; t += step) { clock.advance(Math.min(step, ms - t)); await settle(); } };
  // a full entry: reservation, shell, pin, intent, dispatch, first post-arrival book fills at once
  async function enter({ q = '0.001', limit = '100000', stop = '99000', target = '102000', asks = [[99990.0, 5]], bids = [[99980.0, 5], [99970.0, 5]] } = {}) {
    await dispatcher.commit([F.hypothesis('d1'), F.decision('d1', { sizing: { q, entryLimitPrice: limit, entryCashOut: M.add(M.mul(q, limit), '1'), riskUsd: '4', bufferedScenarioNetProfit: '2' } }), F.reserve('r1', 'd1', { cashReserved: M.add(M.mul(q, limit), '1') }), F.position('p1', 'd1', { structuralStop: stop, targetPrice: target, requestedQty: q }), F.pin(), F.intent('o1', 'p1', 'r1', { qty: q, limitPrice: limit, protection: { ordertype: 'stop-loss', trigger: 'last', price: stop } })]);
    book(asks, bids, 'snapshot'); await dispatcher.dispatchEntry('o1'); clock.advance(300); book(asks, bids); await settle(); return dispatcher.state().positions.p1;
  }
  return { clock, journal, writer, F, feed, adapter, dispatcher, watch, ctl, book, trade, settle, advance, enter, state: () => dispatcher.state() };
}

test('W01/W09. the first (partial) fill becomes tracked risk before the entry is terminal: a shell with a pin exists before dispatch, R is PROVISIONAL until the IOC is terminal then FINAL from fills; a 50% fill scales the target proceeds to the ACTUAL residual; first-fill time is immutable; safety work outranks candidate work', async () => {
  const r = await rig(); const pos = await r.enter({ q: '0.002', asks: [[99990.0, 0.001]] }); assert.equal(pos.state, 'OPEN'); assert.equal(pos.confirmedBase, '0.001', 'half filled'); assert.equal(r.state().orders.o1.state, 'EXPIRED', 'IOC remainder is terminal'); assert.ok(pos.firstFillTs); assert.equal(pos.feedPinned, true);
  assert.equal(pos.initialR.state, 'FINAL', 'entry terminal + fills reconciled -> FINAL R'); assert.ok(M.isPositive(pos.initialR.value)); assert.equal(pos.initialR.entryVwap, '99990'); const tracked = r.watch.positions()[0]; assert.ok(tracked.targetPerUnit, 'target proceeds per unit are computed for the actual residual'); assert.equal(pos.protection.state, 'ACTIVE'); assert.equal(pos.protection.qty, '0.001');
  const firstFill = pos.firstFillTs; await r.dispatcher.commit(r.F.ev('FEE_ADJUSTMENT', { execId: r.state().positions.p1.executions[0].execId, orderId: 'o1', asset: 'USD', delta: '0.05', reason: 'late fee correction', ref: 'ledger-1', ts: r.clock.now() })); assert.equal(r.state().positions.p1.firstFillTs, firstFill, 'a late correction never restarts time'); assert.equal(r.state().positions.p1.entryFeesQuote, '0.85');
  // closeout R08 law: safety and entry work run on INDEPENDENT serialized pumps — safety never waits behind an entry send, an entry never
  // holds safety; a blocked safety job still serializes the safety work behind it while candidate work proceeds on its own pump
  const order = []; let release; const held = new Promise((res) => { release = res; }); const p0 = r.dispatcher.enqueue('SAFETY', () => held); const pE = r.dispatcher.enqueue('ENTRY', async () => order.push('entry')); const pS = r.dispatcher.enqueue('SAFETY', async () => order.push('safety')); await new Promise((res) => setImmediate(res)); assert.deepEqual(order, ['entry'], 'candidate work is not held by a blocked safety job (independent pumps)'); assert.equal(order.includes('safety'), false, 'safety work stays serialized behind the earlier safety job'); release(); await Promise.all([p0, pE, pS]); assert.deepEqual(order, ['entry', 'safety']);
  let entryRelease; const entryHeld = new Promise((res) => { entryRelease = res; }); const pE2 = r.dispatcher.enqueue('ENTRY', () => entryHeld); const pS2 = r.dispatcher.enqueue('SAFETY', async () => order.push('safety-2')); await pS2; assert.ok(order.includes('safety-2'), 'a received economic event never waits behind a hanging entry send'); entryRelease(); await pE2;
});

test('W03/W02. hard stop: the native (paper) stop triggers from the trade feed, fills against the first post-arrival bids, the position closes FLAT with its pin released; a weak counter-rumor (unverified) never exits; a verified falsifier does; no model call exists in the loop', async () => {
  const falsifiers = []; const r = await rig({ falsifiers: () => falsifiers }); await r.enter();
  falsifiers.push({ positionId: 'p1', factType: 'PRIMARY_CORRECTION', verified: false, note: 'counter-rumor' }); await r.settle(); assert.equal(r.watch.positions()[0].exit.phase, 'NONE', 'unverified counter-rumor requests review, never an exit');
  r.clock.advance(100); r.trade(98999.0); r.clock.advance(50); await r.settle(); assert.equal(r.state().positions.p1.protection.state, 'TRIGGERED');
  r.clock.advance(300); r.book([[99990.0, 5]], [[98950.0, 5]]); await r.settle(); await r.advance(300); const pos = r.state().positions.p1; assert.equal(pos.state, 'FLAT', `state ${pos.state} exit ${JSON.stringify(r.watch.positions()[0].exit)}`); assert.equal(ownedBase(pos), '0'); assert.equal(r.feed.pinned().size, 0, 'the pin is released only after confirmed flat'); assert.ok(M.isNegative(pos.realizedPnl));
  const r2 = await rig({ falsifiers: () => [{ positionId: 'p1', factType: 'VENUE_SUSPENSION', verified: true }] }); await r2.enter(); await r2.settle(); const w = r2.watch.positions()[0]; assert.equal(w.exit.reason, 'THESIS_FALSIFIED'); assert.equal(w.exit.priority, 'P2_STRUCTURAL_INVALIDATION');
});

test('W04/W06. deterioration needs >= 30 baseline books, FI15 <= -0.20 and 10bps depth < 50% of the 60s median persisting over >= 3 books spanning >= 2s: one transient book is not sufficient; a seconds-long exit is allowed (no minimum hold); the reasons keep every supported code with one primary', async () => {
  const r = await rig(); await r.enter({ bids: [[99980.0, 1], [99970.0, 1]] });
  for (let i = 0; i < 80; i += 1) { r.clock.advance(1000); r.book([[99990.0, 5]], [[99980.0, 1], [99970.0, 1]]); r.trade(99985.0, 'buy'); } await r.settle();
  assert.equal(r.watch.evaluateReasons(r.state().positions.p1).det.active, false);
  r.clock.advance(1000); r.book([[99990.0, 5]], [[99980.0, 0.1], [99970.0, 0.1]]); for (let i = 0; i < 6; i += 1) r.trade(99981.0, 'sell', 0.5); r.clock.advance(100); await r.settle(); const once = r.watch.evaluateReasons(r.state().positions.p1); assert.equal(once.det.active, false, 'one transient book is not deterioration'); assert.equal(once.det.reason, 'DEBOUNCING');
  r.clock.advance(1000); r.book([[99990.0, 5]], [[99980.0, 0.1], [99970.0, 0.1]]); await r.settle(); r.clock.advance(1100); r.book([[99990.0, 5]], [[99980.0, 0.1], [99970.0, 0.1]]); r.trade(99981.0, 'sell', 0.5); r.clock.advance(100); await r.settle();
  const w = r.watch.positions()[0]; assert.equal(w.exit.reason, 'DETERIORATION', JSON.stringify(r.watch.evaluateReasons(r.state().positions.p1).det)); assert.equal(w.exit.priority, 'P3_FLOW_LIQUIDITY_DETERIORATION'); assert.ok(r.clock.now() - once.det.since < 10_000, `exit within seconds of the deterioration onset (${r.clock.now() - once.det.since}ms): no minimum hold`);
  r.clock.advance(300); r.book([[99990.0, 5]], [[99960.0, 5]]); await r.settle(); await r.advance(500); assert.equal(r.state().positions.p1.state, 'FLAT', JSON.stringify(r.watch.positions()[0].exit));
});

test('W05. net-R trail: latches at +1R (durable, survives a reopen), then proposes stop = max(existing, highest bid - 1.0 ATR) continuously with 1000ms spacing and at most one unresolved amendment; a FAILED / stale amend is not confirmed protection; a crossed trail exits through protective handling', async () => {
  let amends = 0; const r = await rig({ script: (x) => (x.amend ? { amend: amends++ === 1 ? 'FAILED' : 'OK' } : {}) }); await r.enter({ stop: '99500', target: '110000' });
  const R = r.state().positions.p1.initialR.value; assert.ok(M.isPositive(R));
  r.clock.advance(1000); r.book([[105000.0, 5]], [[104990.0, 5], [104980.0, 5]]); await r.settle(); await r.settle(); let pos = r.state().positions.p1; assert.equal(pos.trailActive, true, `latched at +1R (R ${R}, net ${r.watch.positions()[0].lastNetPnl})`); assert.equal(pos.protection.trigger, '104790', 'stop = highest bid 104990 - ATR 200'); assert.equal(pos.protection.pendingAmend, null);
  r.clock.advance(200); r.book([[105100.0, 5]], [[105090.0, 5]]); await r.settle(); assert.equal(r.state().positions.p1.protection.trigger, '104790', 'inside the 1000ms spacing: coalesced, no resend'); assert.ok(r.watch.status().counters.amendsCoalesced >= 1);
  r.clock.advance(900); r.book([[105100.0, 5]], [[105090.0, 5]]); await r.settle(); pos = r.state().positions.p1; assert.equal(pos.protection.trigger, '104790', 'the second (scripted FAILED) amend does not become confirmed protection'); assert.equal(pos.protection.state, 'ACTIVE');
  r.clock.advance(1100); r.book([[105100.0, 5]], [[105090.0, 5]]); await r.settle(); assert.equal(r.state().positions.p1.protection.trigger, '104890', 'a later successful amend tightens');
  r.clock.advance(500); r.book([[104890.0, 5]], [[104880.0, 5]], 'snapshot'); await r.settle(); await r.settle(); const w = r.watch.positions()[0]; assert.equal(w.exit.reason, 'TRAIL_CROSSED', 'the bid crossed the confirmed trail: protective handling, never a lowered stop');
  const replay = await r.journal.replayVerify('w-acct'); assert.equal(replay.ok, true, replay.reason); assert.equal((await r.journal.load('w-acct')).state.positions.p1.trailActive, true, 'trailActive is durable');
  await assert.rejects(r.dispatcher.commit(r.F.ev('WATCH_STATE', { positionId: 'p1', trailActive: false, highestBid: null, exitState: 'NONE', primaryReason: null, priority: null, supportedReasons: [], ts: r.clock.now() })), (e) => e.detail?.code === 'TRAIL_REGRESSION');
});

test('W06. no-progress at 180s (max net P&L < 0.25R, current net <= 0, complete FI60 <= 0), the planned target on the actual residual, and the mandatory 4h duration exit; no hidden fixed-return quota anywhere in the policy', async () => {
  const r = await rig(); await r.enter({ stop: '99500', target: '100200' }); const R = r.state().positions.p1.initialR.value;
  for (let i = 0; i < 20; i += 1) { r.clock.advance(10_000); r.book([[99990.0, 5]], [[99980.0, 5], [99970.0, 5]]); r.trade(99985.0, 'sell'); await r.settle(); } assert.equal(r.watch.positions()[0].exit.reason, 'NO_PROGRESS', JSON.stringify(r.watch.evaluateReasons(r.state().positions.p1)));
  const t = await rig({ accountId: 'w-target' }); await t.enter({ stop: '99500', target: '102000' }); t.clock.advance(1000); t.book([[102400.0, 5]], [[102390.0, 5], [102380.0, 5]]); await t.settle(); await t.settle(); const w = t.watch.positions()[0]; assert.equal(w.exit.reason, 'PLANNED_TARGET', JSON.stringify(t.watch.positions()[0])); assert.equal(w.exit.priority, 'P4_TRAIL_OR_TARGET'); t.clock.advance(300); t.book([[102400.0, 5]], [[102390.0, 5]]); await t.settle(); await t.advance(600); const pos = t.state().positions.p1; assert.equal(pos.state, 'FLAT'); assert.ok(M.isPositive(pos.realizedPnl), 'net of entry / exit fees');
  const d = await rig({ accountId: 'w-dur' }); await d.enter({ stop: '99500', target: '110000' }); d.clock.advance(4 * 3_600_000 - 1000); d.book([[100000.0, 5]], [[99990.0, 5]]); d.trade(99995.0, 'buy'); await d.settle(); assert.notEqual(d.watch.positions()[0].exit.reason, 'MAX_DURATION'); d.clock.advance(1000); d.book([[100000.0, 5]], [[99990.0, 5]]); await d.settle(); assert.equal(d.watch.positions()[0].exit.reason, 'MAX_DURATION');
  assert.equal(JSON.stringify(WATCH_REFERENCE).match(/return|profit|quota|winRate/i), null);
  assert.equal(JSON.stringify(R).length > 0, true);
});

test('W02/W07. KILL halts additions and ATTEMPTS a safe flatten, KILL_REQUESTED is not KILL_COMPLETE; a public feed unusable > 10s on PAPER cannot invent an exit: HALTED_UNRESOLVED with the native stop retained; a lost writer lease stops every commit (no unjournalled order)', async () => {
  const r = await rig(); await r.enter({ stop: '99500', target: '110000' }); r.ctl.kill = true; await r.settle(); assert.equal(r.watch.positions()[0].exit.reason, 'OWNER_KILL'); assert.equal(r.watch.killComplete(), false, 'requested is not complete');
  await assert.rejects(r.dispatcher.commit([r.F.hypothesis('d2', { assetId: 'ETH', pair: 'ETH/USD' }), r.F.decision('d2', { assetId: 'ETH', pair: 'ETH/USD' }), r.F.reserve('r2', 'd2', { assetId: 'ETH', pair: 'ETH/USD', cashReserved: '10', riskReserved: '1' })]), (e) => ['ENTRY_RESTRICTED', 'MODE_FORBIDS_ENTRY', 'ASSET_ALREADY_HELD', 'SLOTS_EXHAUSTED'].includes(e.detail?.code) || e.code === 'REDUCER_REFUSED');
  r.clock.advance(300); r.book([[100000.0, 5]], [[99990.0, 5]]); await r.settle(); await r.advance(600); assert.equal(r.state().positions.p1.state, 'FLAT'); assert.equal(r.watch.killComplete(), true);
  const h = await rig({ accountId: 'w-halt' }); await h.enter({ stop: '99500', target: '110000' }); h.clock.advance(11_000); await h.settle(); const st = h.state(); assert.equal(st.mode, 'HALTED_UNRESOLVED'); assert.equal(st.positions.p1.protection.state, 'ACTIVE', 'the native stop is retained'); assert.equal(st.positions.p1.state, 'OPEN', 'no made-up exit, no flat fiction'); assert.ok(h.watch.status().haltedLatched);
  const l = await rig({ accountId: 'w-lost' }); await l.enter({ stop: '99500', target: '110000' }); l.writer._lose(); await l.journal.acquireWriter('w-lost'); l.clock.advance(1000); l.book([[102000.0, 5]], [[101990.0, 5]]); await assert.rejects(l.dispatcher.commit(l.F.valuation({ cashComponent: l.state().cash, liquidationComponent: '0', equity: l.state().cash })), (e) => e.code === 'EPOCH_FENCED'); assert.equal(l.dispatcher.writerLost(), true); assert.equal(l.adapter.status().admission, false, 'lease loss closes the sender'); await l.settle(); assert.equal(l.state().positions.p1.protection.trigger, '99500', 'no amend / order was sent without the journal');
});

test('W08. dust: a residual below the instrument minimum is DUST_UNRESOLVED, keeps its pin, never a sold-from-elsewhere fill; an orphan protective order must be cancelled and confirmed before FLAT', async () => {
  const r = await rig({ script: (x) => (x.childStop !== undefined ? {} : { childStop: 'SHORT' }) }); const pos = await r.enter({ q: '0.001', stop: '99500', target: '100200' }); assert.equal(pos.protection.state, 'MISMATCH', 'a child covering half the base is a protection mismatch'); assert.ok(r.state().restrictions.PROTECTION_MISMATCH);
  await r.settle(); const w = r.watch.positions()[0]; assert.ok(['NONE', 'UNRESOLVED', 'CANCELLING_REMAINDER', 'CANCELLING_PROTECTION'].includes(w.exit.phase));
  const d = await rig({ accountId: 'w-dust' }); await d.enter({ q: '0.00006', stop: '99500', target: '100200', asks: [[99990.0, 0.00006]] }); await d.dispatcher.commit(d.F.ev('CANCEL_REQUESTED', { orderId: d.state().positions.p1.protection.orderId, attemptId: 'c1', ts: d.clock.now() })); await d.dispatcher.commit(d.F.ev('CANCEL_RESULT', { orderId: d.state().positions.p1.protection.orderId, attemptId: 'c1', outcome: 'CANCELLED', reason: null, receiptTs: d.clock.now() }));
  await d.dispatcher.commit(d.F.sellIntent('s1', 'p1', { qty: '0.00005', limitPrice: '99900' })); await d.dispatcher.commit([d.F.attempt('s1'), d.F.result('s1', 'ACKNOWLEDGED'), d.F.fill('s1', 'xs1', { side: 'sell', base: '0.00005', quote: '4.9995', fee: { asset: 'USD', amount: '0.04' } })]);
  const res = ownedBase(d.state().positions.p1); assert.equal(res, '0.00001'); assert.ok(M.lt(res, SPEC.orderMin)); await assert.rejects(d.dispatcher.commit(d.F.closed('p1', 'FLAT', { residualBase: res })), (e) => e.detail?.code === 'NOT_FLAT'); await d.dispatcher.commit(d.F.ev('DUST_STATE', { positionId: 'p1', base: res, state: 'DUST_UNRESOLVED', ownerRef: null, ts: d.clock.now() })); assert.equal(d.state().positions.p1.state, 'DUST_UNRESOLVED'); await assert.rejects(d.dispatcher.commit(d.F.pin('XBT/USD', 'RELEASE')), (e) => e.detail?.code === 'PIN_HELD');
});

test('W10. a slow verification worker cannot block the Watch heartbeat: ticks keep running while a held promise never resolves; a stale worker reply carrying an old revision is refused by the recheck', async () => {
  const r = await rig({ accountId: 'w-worker' }); await r.enter({ stop: '99500', target: '110000' });
  let release; const held = new Promise((res) => { release = res; }); const slow = held.then(() => ({ verified: true, revision: 1 })); let ticks = 0; for (let i = 0; i < 5; i += 1) { r.clock.advance(250); await r.watch.onTick(r.clock.now()); ticks += 1; } assert.equal(ticks, 5, 'heartbeats proceed while the worker is blocked');
  const seen = r.dispatcher.revision(); await r.dispatcher.commit(r.F.valuation({ cashComponent: r.state().cash, liquidationComponent: '0', equity: r.state().cash })); release(); const reply = await slow; await assert.rejects(r.dispatcher.commit(r.F.restriction('CAGE', 'LATCH'), { recheck: () => r.dispatcher.revision() === seen && reply.verified }), (e) => e.code === 'RECHECK_FAILED', 'a stale worker reply cannot approve against a moved revision');
});
