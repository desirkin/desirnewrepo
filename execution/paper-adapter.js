// EXECUTION — the PAPER adapter (ticket §7.5): same instruments, reservations, fees, controls and lifecycle as LIVE; only the
// venue is simulated, and the simulation is declared conservative. Simulated arrival = dispatch + latency (reference
// 250ms); the fill samples the FIRST accepted executable book received at/after arrival within at most 1000ms (its
// sequence and intervening health retained; never a later favorable book, never pre-dispatch levels); no such book ->
// UNFILLED_COVERAGE_UNKNOWN (unscorable, never a zero-loss fill). IOC consumes displayed asks up to the cap at that ONE
// sampled book; the unfilled remainder is terminal. Displayed liquidity depletion belongs to an account / pair / side /
// price-level GENERATION: available = max(0, Q - U); an unrelated update, identical quantity, heartbeat or repeat snapshot
// never resets U; an observed increase adds only its real increment; a decrease never refunds; reset only after an explicit
// removal (Q = 0) followed by a newly observed positive level; continuity loss marks consumed levels PAPER_LIQUIDITY_UNCERTAIN.
// Paper stops trigger from the accepted trade feed (trigger = last) and fill against the first qualifying bids under the
// same post-arrival rule. No paper order enters the venue: every result carries this limitation label.
import * as M from './money.js';
import { adapterEvent } from './adapter-contract.js';
import { feesForExecutions } from './fees.js';

export const PAPER_LIMITATION = 'PAPER_SIMULATION: displayed depth can disappear; own impact and queue competition are estimates; no venue order exists';
export const PAPER_DEFAULTS = Object.freeze({ latencyMs: 250, maxObservationWaitMs: 1000, exitLatencyMs: 250 });
const key = (pair, side, price) => `${pair}|${side}|${price}`;

export function createPaperAdapter({ accountId, clock, feed = null, fee, specOf, latencyMs = PAPER_DEFAULTS.latencyMs, maxObservationWaitMs = PAPER_DEFAULTS.maxObservationWaitMs, script = () => ({}), restore = null, log = () => {} } = {}) {
  const listeners = new Set(); const pending = new Map(); const stops = new Map(); const orders = new Map(); const depletion = new Map(); const firstSnapshotSeen = new Set();
  let admission = true; let seq = 0; let execSeq = 0; const counters = { submitted: 0, filled: 0, partial: 0, unfilledCoverageUnknown: 0, stopsTriggered: 0, extraObservationWaits: [], uncertainLevels: 0 };
  const emit = (type, payload, receiptTs) => { const ev = adapterEvent('PAPER', type, payload, receiptTs); for (const fn of listeners) { try { fn(ev); } catch (err) { log(`paper listener error: ${err?.message ?? err}`); } } return ev; };
  if (restore?.levels) for (const [k, v] of restore.levels) depletion.set(k, { ...v });
  const dep = (k) => depletion.get(k) ?? (depletion.set(k, { generation: 1, consumed: '0', uncertain: false, tombstone: false, lastObserved: null }), depletion.get(k));
  const available = (pair, side, price, qty) => { const d = depletion.get(key(pair, side, price)); if (!d) return qty; if (d.uncertain) return '0'; return M.max('0', M.sub(qty, d.consumed)); };
  function observeBook(ev) {
    const { symbol, snapshot, changes } = ev;
    if (snapshot.kind === 'SNAPSHOT') { const first = !firstSnapshotSeen.has(symbol); firstSnapshotSeen.add(symbol); if (!first) { for (const [k, d] of depletion) if (k.startsWith(`${symbol}|`) && !M.isZero(d.consumed) && !d.uncertain) { d.uncertain = true; counters.uncertainLevels += 1; } } for (const side of ['bids', 'asks']) for (const [price] of snapshot[side]) { const d = depletion.get(key(symbol, side, price)); if (d) d.lastObserved = snapshot.receiptTs; } return; }
    for (const [side, price, qty] of changes ?? []) { const k = key(symbol, side, price); const d = dep(k); if (M.isZero(qty)) { d.tombstone = true; d.lastObserved = snapshot.receiptTs; continue; } if (d.tombstone) { d.generation += 1; d.consumed = '0'; d.uncertain = false; d.tombstone = false; } d.lastObserved = snapshot.receiptTs; }
  }
  // walk one side of the sampled book for qty at or better than `cap` (null cap = protective market), honoring depletion
  function walk(pair, snapshot, side, qty, cap) {
    const levels = snapshot[side]; const fills = []; let remaining = qty; let consumedLevels = 0;
    for (const [price, shown] of levels) { if (M.isZero(remaining)) break; if (cap !== null && (side === 'asks' ? M.gt(price, cap) : M.lt(price, cap))) break; const avail = available(pair, side, price, shown); if (M.isZero(avail)) continue; const take = M.min(avail, remaining); fills.push({ price, base: take, quote: M.mul(price, take) }); remaining = M.sub(remaining, take); consumedLevels += 1; }
    return { fills, remaining, consumedLevels, exhausted: !M.isZero(remaining) };
  }
  function consume(pair, side, fills) { for (const f of fills) { const d = dep(key(pair, side, f.price)); d.consumed = M.add(d.consumed, f.base); } }
  function settle(order, snapshot, now) {
    const { intent, spec } = order; const side = intent.side === 'buy' ? 'asks' : 'bids'; const cap = intent.orderType === 'market' ? null : intent.limitPrice;
    const wait = snapshot.receiptTs - order.arrivalTs; counters.extraObservationWaits.push(wait); if (counters.extraObservationWaits.length > 512) counters.extraObservationWaits.shift();
    const w = walk(intent.pair, snapshot, side, intent.qty, cap); const sc = script(intent) ?? {};
    const rounded = w.fills.map((f) => ({ ...f, base: M.roundToStep(f.base, spec.qtyIncrement, 'DOWN') })).filter((f) => !M.isZero(f.base)).map((f) => ({ ...f, quote: M.mul(f.price, f.base) }));
    consume(intent.pair, side, rounded);
    const fees = rounded.length ? feesForExecutions(fee, rounded) : { perExecution: [], total: '0' };
    order.sampled = { snapshotDigest: snapshot.digest, receiptSequence: snapshot.receiptSequence, feedEpoch: snapshot.feedEpoch, observationWaitMs: wait, consumedLevels: w.consumedLevels, limitation: PAPER_LIMITATION };
    let cum = '0'; rounded.forEach((f, i) => { execSeq += 1; cum = M.add(cum, f.base); const baseFee = fee.currency === 'BASE' ? M.roundToStep(M.div(M.mul(f.base, fee.rate), '1', spec.qtyDecimals, 'UP'), spec.qtyIncrement, 'UP') : null; emit('EXECUTION_RECORDED', { orderId: intent.orderId, execId: `pex-${accountId}-${execSeq}`, nativeOrderId: order.nativeOrderId, side: intent.side, base: f.base, quote: f.quote, price: f.price, fee: fee.currency === 'BASE' ? { asset: spec.canonicalCoin, amount: baseFee } : { asset: 'USD', amount: fees.perExecution[i] }, sourceTs: snapshot.receiptTs, receiptTs: now, origin: 'PAPER', ordRefId: order.ordRefId ?? null, nativeCumQty: cum, sequence: ++seq }, now); });
    const filledAll = M.eq(cum, intent.qty);
    if (rounded.length) { counters.filled += 1; if (!filledAll) counters.partial += 1; } else counters.unfilledCoverageUnknown += 0;
    emit('ORDER_STATE', { orderId: intent.orderId, state: filledAll ? 'FILLED' : 'EXPIRED', nativeOrderId: order.nativeOrderId, nativeCumQty: cum, reason: filledAll ? null : rounded.length ? 'IOC_PARTIAL_REMAINDER_TERMINAL' : 'IOC_NO_FILL_AT_SAMPLED_BOOK', sourceTs: snapshot.receiptTs, receiptTs: now }, now);
    order.resolved = true; pending.delete(intent.orderId); order.result = { filledBase: cum, fills: rounded };
    if (order.kind === 'ENTRY' && !M.isZero(cum)) createChildStop(order, cum, now, sc);
    if (order.kind === 'STOP_FILL') { const st = stops.get(order.stopOrderId); if (st) st.state = filledAll ? 'FILLED' : 'PARTIAL'; }
  }
  function createChildStop(order, filledBase, now, sc) {
    const { intent, spec } = order; const netBase = fee.currency === 'BASE' ? M.sub(filledBase, M.sum(order.result.fills.map((f) => M.roundToStep(M.div(M.mul(f.base, fee.rate), '1', spec.qtyDecimals, 'UP'), spec.qtyIncrement, 'UP')))) : filledBase;
    const child = sc.childStop ?? 'OK'; const stopId = `pstop-${intent.orderId}`;
    emit('PROTECTION_STATE', { positionId: intent.positionId, orderId: null, state: 'PENDING', nativeOrderId: null, trigger: intent.protection.price, qty: netBase, sourceTs: now, receiptTs: now, reason: 'conditional close requested with entry' }, now);
    if (child === 'REJECT') { emit('PROTECTION_STATE', { positionId: intent.positionId, orderId: null, state: 'FAILED', nativeOrderId: null, trigger: intent.protection.price, qty: netBase, sourceTs: now, receiptTs: now, reason: 'scripted: venue rejected the conditional close' }, now); return; }
    if (child === 'UNCERTAIN') { emit('PROTECTION_STATE', { positionId: intent.positionId, orderId: null, state: 'MISMATCH', nativeOrderId: null, trigger: intent.protection.price, qty: netBase, sourceTs: now, receiptTs: now, reason: 'scripted: conditional close result unknown' }, now); return; }
    const qty = child === 'SHORT' ? M.roundToStep(M.div(netBase, '2', spec.qtyDecimals, 'DOWN'), spec.qtyIncrement, 'DOWN') : netBase;
    stops.set(stopId, { stopOrderId: stopId, positionId: intent.positionId, pair: intent.pair, trigger: intent.protection.price, qty, state: 'ACTIVE', spec, parentOrderId: intent.orderId, ordRefId: order.nativeOrderId });
    emit('PROTECTION_STATE', { positionId: intent.positionId, orderId: null, state: 'ACTIVE', nativeOrderId: stopId, trigger: intent.protection.price, qty, sourceTs: now, receiptTs: now, reason: 'paper conditional close active (trigger=last)' }, now);
  }
  function onTrade(ev) { const now = ev.trade.receiptTs; for (const st of stops.values()) { if (st.state !== 'ACTIVE' || st.pair !== ev.symbol) continue; if (M.lte(ev.trade.price, st.trigger)) { st.state = 'TRIGGERED'; st.triggeredTs = now; counters.stopsTriggered += 1; emit('PROTECTION_STATE', { positionId: st.positionId, orderId: st.journalOrderId ?? null, state: 'TRIGGERED', nativeOrderId: st.stopOrderId, trigger: st.trigger, qty: st.qty, sourceTs: ev.trade.eventTs, receiptTs: now, reason: `last ${ev.trade.price} <= trigger ${st.trigger}` }, now); const oid = st.journalOrderId ?? st.stopOrderId; pending.set(oid, { kind: 'STOP_FILL', stopOrderId: st.stopOrderId, intent: { orderId: oid, positionId: st.positionId, pair: st.pair, side: 'sell', qty: st.qty, orderType: 'market', limitPrice: null }, spec: st.spec, arrivalTs: now + PAPER_DEFAULTS.exitLatencyMs, submittedTs: now, nativeOrderId: st.stopOrderId, ordRefId: st.ordRefId, resolved: false }); } } }
  function onBook(ev) { observeBook(ev); const snap = ev.snapshot; if (!snap.synced) return; for (const o of [...pending.values()]) { if (o.resolved || o.intent.pair !== ev.symbol) continue; if (snap.receiptTs < o.arrivalTs) continue; if (snap.receiptTs > o.arrivalTs + maxObservationWaitMs) continue; settle(o, snap, snap.receiptTs); } }
  function onTick(now = clock()) { for (const o of [...pending.values()]) { if (o.resolved) continue; if (now > o.arrivalTs + maxObservationWaitMs) { o.resolved = true; pending.delete(o.intent.orderId); counters.unfilledCoverageUnknown += 1; emit('ORDER_STATE', { orderId: o.intent.orderId, state: 'EXPIRED', nativeOrderId: o.nativeOrderId, nativeCumQty: '0', reason: 'UNFILLED_COVERAGE_UNKNOWN: no accepted book within the bounded post-arrival window (unscorable)', sourceTs: null, receiptTs: now }, now); if (o.kind === 'STOP_FILL') { const st = stops.get(o.stopOrderId); if (st) st.state = 'UNFILLED_COVERAGE_UNKNOWN'; } } } }
  if (feed) feed.subscribe((ev) => { if (ev.kind === 'BOOK') onBook(ev); else if (ev.kind === 'TRADE') onTrade(ev); else if (ev.kind === 'EPOCH') { for (const d of depletion.values()) if (!M.isZero(d.consumed) && !d.uncertain) { d.uncertain = true; counters.uncertainLevels += 1; } } });
  const adapter = {
    kind: 'PAPER', accountId, limitation: PAPER_LIMITATION,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async preflight() { return { ok: true, adapter: 'PAPER', liveCapable: false, privateAccess: 'NONE', limitation: PAPER_LIMITATION }; },
    async reconcile({ scope = 'PERIODIC' } = {}) { const now = clock(); return emit('RECONCILIATION', { reconciliationId: `prec-${accountId}-${++seq}`, scope, outcome: 'COMPLETE', balances: null, openOrdersSeen: [...stops.values()].filter((s) => s.state === 'ACTIVE').length, executionsSeen: execSeq, unmatched: 0, pagesRead: 0, pageIncomplete: false, cursorTs: now, reason: 'paper venue: internal simulation state is the only truth', ts: now }, now).payload; },
    // returns the dispatch result at simulated arrival; fills / states follow through subscribe
    async submitEntryWithProtection({ intent, spec: givenSpec }) {
      if (!admission) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'ADMISSION_STOPPED', guaranteesNoAcceptance: true };
      const spec = givenSpec ?? specOf(intent.pair); const sc = script(intent) ?? {}; const now = clock(); counters.submitted += 1;
      if (sc.dispatch === 'UNCERTAIN') { orders.set(intent.orderId, { intent, spec, uncertain: true }); return { outcome: 'UNCERTAIN', nativeOrderId: null, reason: 'scripted: transport timeout after send', guaranteesNoAcceptance: false }; }
      if (sc.dispatch === 'REJECT') return { outcome: 'REJECTED', nativeOrderId: null, reason: 'scripted: EOrder:Invalid', guaranteesNoAcceptance: true };
      const nativeOrderId = `pord-${accountId}-${++seq}`; const order = { kind: 'ENTRY', intent, spec, arrivalTs: now + latencyMs, submittedTs: now, nativeOrderId, resolved: false }; pending.set(intent.orderId, order); orders.set(intent.orderId, order);
      return { outcome: 'ACKNOWLEDGED', nativeOrderId, reason: null, guaranteesNoAcceptance: false, arrivalTs: order.arrivalTs };
    },
    async amendProtection({ positionId, orderId, amendId, requestedTrigger }) { const now = clock(); const st = [...stops.values()].find((s) => s.positionId === positionId && s.state === 'ACTIVE'); const sc = script({ amend: true, positionId }) ?? {}; if (!st) return { outcome: 'FAILED', confirmedTrigger: null, reason: 'no active paper stop' }; if (sc.amend === 'UNCERTAIN') return { outcome: 'UNCERTAIN', confirmedTrigger: null, reason: 'scripted: amend response lost' }; if (sc.amend === 'FAILED') return { outcome: 'FAILED', confirmedTrigger: st.trigger, reason: 'scripted: EOrder:Unknown order' }; st.trigger = requestedTrigger; return { outcome: 'ACKNOWLEDGED', confirmedTrigger: requestedTrigger, reason: null, amendId }; },
    async cancelOwnedOrder({ orderId, nativeOrderId, attemptId }) { const now = clock(); const st = stops.get(nativeOrderId); const sc = script({ cancel: true, orderId }) ?? {}; if (sc.cancel === 'UNCERTAIN') return { outcome: 'UNCERTAIN', reason: 'scripted: cancel response lost' }; if (st) { if (st.state === 'ACTIVE') { st.state = 'CANCELLED'; return { outcome: 'CANCELLED', reason: null }; } return { outcome: 'ALREADY_TERMINAL', reason: `stop ${st.state}` }; } const o = orders.get(orderId); if (o?.uncertain) return { outcome: 'UNCERTAIN', reason: 'order dispatch was uncertain; reconcile' }; if (o && o.resolved) return { outcome: 'ALREADY_TERMINAL', reason: 'IOC already terminal' }; if (o) { pending.delete(orderId); o.resolved = true; return { outcome: 'CANCELLED', reason: null }; } return { outcome: 'REJECTED', reason: 'unknown order' }; },
    // a protective market sell of a confirmed residual: same post-arrival sampling law, no price guarantee
    async closeResidual({ intent, spec: givenSpec }) { if (!admission && intent.kind === 'PLANNED_EXIT') return { outcome: 'REJECTED', nativeOrderId: null, reason: 'ADMISSION_STOPPED', guaranteesNoAcceptance: true }; const spec = givenSpec ?? specOf(intent.pair); const now = clock(); const nativeOrderId = `pexit-${accountId}-${++seq}`; const order = { kind: 'EXIT', intent, spec, arrivalTs: now + PAPER_DEFAULTS.exitLatencyMs, submittedTs: now, nativeOrderId, resolved: false }; pending.set(intent.orderId, order); orders.set(intent.orderId, order); return { outcome: 'ACKNOWLEDGED', nativeOrderId, reason: null, guaranteesNoAcceptance: false, arrivalTs: order.arrivalTs }; },
    // bind a durable journal order id to a paper stop so its trigger fill references the journal's PROTECTIVE_STOP order
    bindStopOrder(positionId, journalOrderId) { const st = [...stops.values()].find((s) => s.positionId === positionId && s.state === 'ACTIVE'); if (st) st.journalOrderId = journalOrderId; return Boolean(st); },
    stopAdmission() { admission = false; return { admission }; },
    async drain({ maxWaitMs = 10_000 } = {}) { admission = false; return { pending: pending.size, uncertain: [...orders.values()].filter((o) => o.uncertain).length, stopsActive: [...stops.values()].filter((s) => s.state === 'ACTIVE').length }; },
    onTick, onBook, onTrade,
    checkpoint: () => ({ version: 'paper-depletion-checkpoint-1', accountId, ts: clock(), levels: [...depletion.entries()].filter(([, d]) => !M.isZero(d.consumed) || d.uncertain || d.tombstone).map(([k, d]) => [k, { generation: d.generation, consumed: d.consumed, uncertain: d.uncertain, tombstone: d.tombstone, lastObserved: d.lastObserved }]) }),
    availableAt: (pair, side, price, shownQty) => available(pair, side, price, shownQty),
    depletionOf: (pair, side, price) => depletion.get(key(pair, side, price)) ?? null,
    sampled: (orderId) => orders.get(orderId)?.sampled ?? null,
    status: () => ({ adapter: 'PAPER', admission, pending: pending.size, stops: [...stops.values()].map((s) => ({ stopOrderId: s.stopOrderId, positionId: s.positionId, state: s.state, trigger: s.trigger, qty: s.qty })), counters: { ...counters, extraObservationWaits: undefined, observationWaitSamples: counters.extraObservationWaits.length, observationWaitMaxMs: counters.extraObservationWaits.length ? Math.max(...counters.extraObservationWaits) : null }, depletionLevels: depletion.size, limitation: PAPER_LIMITATION }),
  };
  return adapter;
}
