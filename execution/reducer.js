// EXECUTION — the ONE account reducer (ticket §3.1): validates every cause / reference relation, quantity sum and allowed
// transition, identically on append and on replay. Pure: (state, event) -> new state, or a typed ReducerRefusal. No I/O,
// no clock (events carry their clocks). Exact decimals throughout; a refusal never mutates the input state.
// Conservation laws (§3.2): cash = initial + admitted external quote flows - buy consideration - quote fees + sell proceeds;
// owned base = bought - sold - base fees + verified inventory adjustments; available cash excludes open reservations.
import * as M from './money.js';
import { eventError, ACCOUNT_STATE_VERSION, TERMINAL_ORDER_STATES, digestOf } from './contract.js';

export class ReducerRefusal extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const refuse = (code, message) => { throw new ReducerRefusal(code, message); };
const MAX_RECENT = 256; const MAX_EXTERNAL = 64; // execution / adjustment identities are durable: never evicted (closeout R03 / R06)
const HARD_RESTRICTIONS = Object.freeze(['KILL', 'RECONCILIATION_REQUIRED', 'PROTECTION_MISMATCH', 'CLOCK_UNTRUSTED', 'WRITER_LOST', 'DB_UNAVAILABLE']);
export const ENTRY_BLOCKING_RESTRICTIONS = Object.freeze([...HARD_RESTRICTIONS, 'CAGE', 'DAILY_LOSS', 'PEAK_DRAWDOWN', 'GAIN_LOCK_PROTECT', 'GAIN_LOCK_HARD', 'FEED_IMPAIRED', 'FEE_BOUND_MISMATCH', 'ARM_EXPIRED', 'OWNER_LIMITS_REQUIRED', 'OVERLOAD', 'PAPER_LIQUIDITY_UNCERTAIN']);

export function emptyAccountState(accountId) {
  return { stateVersion: ACCOUNT_STATE_VERSION, accountId, initialized: false, accountKind: null, mode: 'OBSERVE', venue: null, quote: null, initialCapital: null, policyDigest: null, policyVersion: null, ownerRef: null, limits: null, compounding: null,
    cash: '0', externalFlows: '0', flowsUnknown: false, reservations: {}, orders: {}, positions: {}, hypotheses: {}, decisions: {}, decisionOrder: [], execIds: {}, execOrder: [], externalActivity: [], authorization: null, authorizations: {}, canaryEvidence: null,
    restrictions: {}, vetoes: [], valuation: { ts: null, equity: null, cashComponent: null, liquidationComponent: null, unknown: true, reason: 'NO_VALUATION' },
    performance: { highWater: null, riskPerformanceEquity: null, drawdown: null, session: null }, realized: { pnl: '0', fees: '0', baseFees: {} }, lastReconciliation: null, clockAnchor: null, pins: {}, adjustments: {},
    counters: { events: 0, fills: 0, decisions: {}, refusedDuplicates: 0, externalActivity: 0 } };
}
const clone = (s) => structuredClone(s);
const openReservations = (s) => Object.values(s.reservations).filter((r) => r.state === 'OPEN');
export const availableCash = (s) => M.sub(s.cash, M.sum(openReservations(s).map((r) => r.cashReserved)));
export const reservedRisk = (s) => M.sum(openReservations(s).map((r) => r.riskReserved));
const heldPositions = (s) => Object.values(s.positions).filter((p) => !['FLAT'].includes(p.state));
export const ownedBase = (p) => M.sub(M.sub(p.confirmedBase, p.soldBase), p.baseFees);
export const slotsUsed = (s) => { const assets = new Set(); for (const p of heldPositions(s)) if (p.state !== 'DUST_UNRESOLVED') assets.add(p.assetId); for (const r of openReservations(s)) assets.add(r.assetId); return assets.size; };
export const hasRestriction = (s, code) => Boolean(s.restrictions[code]);
// the allocation law (closeout R01): cash deployed = open reservations + net cost of held inventory; an active authorization's
// ceiling bounds it; reinvestment NONE keeps realized gains out of the deployable amount, REALIZED_WITHIN_CEILING lets them
// be redeployed up to the ceiling. null = no authorization bounds this account (a hypothetical / paper account without an arm).
export const deployedAllocation = (s) => M.add(M.sum(openReservations(s).map((r) => r.cashReserved)), M.sum(heldPositions(s).map((p) => M.max('0', M.sub(M.add(p.entryQuote, p.entryFeesQuote), M.sub(p.exitQuote, p.exitFeesQuote))))));
export function allocationRemaining(s, ts = null) { const a = s.authorization; if (!a || a.ended || (ts !== null && a.expiresTs <= ts)) return null; const gains = M.max('0', s.realized.pnl); const deployable = a.reinvestment === 'REALIZED_WITHIN_CEILING' ? a.allocationCeiling : M.max('0', M.sub(a.allocationCeiling, gains)); return M.max('0', M.sub(deployable, deployedAllocation(s))); }
export const entryBlockingRestrictions = (s) => ENTRY_BLOCKING_RESTRICTIONS.filter((c) => s.restrictions[c]);
const authorizationActive = (s, ts) => s.authorization && s.authorization.expiresTs > ts && !s.authorization.ended;
const pushBounded = (list, item, max) => { list.push(item); if (list.length > max) list.splice(0, list.length - max); };
const feeParts = (fee, quote, base) => { if (!fee) return { quoteFee: '0', baseFee: '0', otherFee: null }; if (fee.asset === quote) return { quoteFee: fee.amount, baseFee: '0', otherFee: null }; if (fee.asset === base) return { quoteFee: '0', baseFee: fee.amount, otherFee: null }; return { quoteFee: '0', baseFee: '0', otherFee: fee }; };
const orderOf = (s, id) => s.orders[id] ?? refuse('ORDER_UNKNOWN', `order ${id} unknown`);
const positionOf = (s, id) => s.positions[id] ?? refuse('POSITION_UNKNOWN', `position ${id} unknown`);
const requireInit = (s) => { if (!s.initialized) refuse('ACCOUNT_UNINITIALIZED', 'account not initialized'); };

export function applyEvent(prev, ev) {
  const e = eventError(ev); if (e) refuse('EVENT_INVALID', e);
  if (ev.accountId !== prev.accountId) refuse('ACCOUNT_MISMATCH', 'event belongs to another account');
  const s = clone(prev); const p = ev.payload; const H = HANDLERS[ev.type]; if (!H) refuse('EVENT_TYPE_UNKNOWN', ev.type);
  if (ev.type !== 'ACCOUNT_INITIALIZED') requireInit(s);
  H(s, p, ev); s.counters.events += 1; return s;
}
export function replayEvents(accountId, events) { let s = emptyAccountState(accountId); for (const ev of events) s = applyEvent(s, ev); return s; }
export const stateDigest = (s) => digestOf({ ...s, counters: null });

const HANDLERS = {
  ACCOUNT_INITIALIZED(s, p, ev) {
    if (s.initialized) refuse('ACCOUNT_ALREADY_INITIALIZED', 'refusing to reset an existing account (no implicit deposit)');
    Object.assign(s, { initialized: true, accountKind: p.accountKind, venue: p.venue, quote: p.quote, initialCapital: p.initialCapital, policyDigest: p.policyDigest, policyVersion: p.policyVersion, ownerRef: p.ownerRef, limits: p.limits, compounding: p.compounding, cash: p.initialCapital, externalFlows: '0' });
    s.mode = p.accountKind === 'LIVE' ? 'LIVE_UNARMED' : p.accountKind === 'REPLAY' ? 'REPLAY' : p.accountKind === 'SHADOW' ? 'REPLAY' : 'PAPER';
    s.valuation = { ts: ev.knownAtTs, equity: p.initialCapital, cashComponent: p.initialCapital, liquidationComponent: '0', unknown: false, reason: 'INITIAL' };
    s.performance = { highWater: p.initialCapital, riskPerformanceEquity: p.initialCapital, drawdown: 0, session: { date: p.sessionDate, openingEquity: p.initialCapital, openingFlows: '0', dayPnl: '0', dayLossFraction: 0 } };
    s.clockAnchor = { anchorUtcTs: p.clockAnchorTs, trusted: true, source: 'LOCAL_WALL', watermarkTs: p.clockAnchorTs };
  },
  ACCOUNT_AUTHORIZED(s, p, ev) {
    if (s.authorizations[p.authorizationId]) refuse('AUTHORIZATION_DUPLICATE', p.authorizationId);
    if (p.kind === 'LIVE_ARM' || p.kind === 'CANARY') { if (s.accountKind !== 'LIVE') refuse('AUTHORIZATION_KIND_MISMATCH', `${p.kind} needs a LIVE account, not ${s.accountKind}`); if (p.limits === null) refuse('OWNER_LIMITS_REQUIRED', 'LIVE arming requires explicit owner limits for every field'); if (p.keyFingerprint === null) refuse('KEY_BINDING_REQUIRED', 'LIVE arming binds a key fingerprint'); if (p.kind === 'CANARY' && p.canary === null) refuse('CANARY_BOUNDS_REQUIRED', 'canary needs its own bounded authorization'); }
    if (p.kind === 'PAPER_RUN' && s.accountKind !== 'PAPER') refuse('AUTHORIZATION_KIND_MISMATCH', 'PAPER_RUN needs a PAPER account');
    if (p.expiresTs <= p.issuedTs) refuse('AUTHORIZATION_EXPIRY', 'expiry must follow issuance');
    if (s.authorization && !s.authorization.ended && s.authorization.expiresTs > ev.knownAtTs && s.authorization.kind !== p.kind) refuse('AUTHORIZATION_EXCLUSIVE', 'canary and ordinary LIVE entries are mutually exclusive on one account');
    // the ordinary LIVE arm needs qualified canary evidence on THIS account under the SAME release (closeout R14): a COMPLETED, reconciled canary
    if (p.kind === 'LIVE_ARM') { const ce = s.canaryEvidence; if (!ce || ce.releaseDigest !== p.releaseDigest) refuse('CANARY_EVIDENCE_REQUIRED', ce ? `the completed canary belongs to release ${String(ce.releaseDigest).slice(0, 12)}, not ${String(p.releaseDigest).slice(0, 12)}` : 'no COMPLETED reconciled canary on this account'); if (p.canaryEvidence && p.canaryEvidence.authorizationId !== ce.authorizationId) refuse('CANARY_EVIDENCE_MISMATCH', `${p.canaryEvidence.authorizationId} is not the completed canary ${ce.authorizationId}`); }
    const a = { ...p, canaryEvidence: p.kind === 'LIVE_ARM' ? { authorizationId: s.canaryEvidence.authorizationId, releaseDigest: s.canaryEvidence.releaseDigest, completedTs: s.canaryEvidence.completedTs } : null, ended: false, endedReason: null }; s.authorizations[p.authorizationId] = a; s.authorization = a;
    if (p.limits) s.limits = p.limits;
  },
  AUTHORIZATION_ENDED(s, p) { const a = s.authorizations[p.authorizationId] ?? refuse('AUTHORIZATION_UNKNOWN', p.authorizationId); if (a.ended) refuse('AUTHORIZATION_ALREADY_ENDED', p.authorizationId);
    // COMPLETED is the canary outcome (closeout R14): every canary entry terminal with certainty, its position flat, no uncertain dispatch
    if (p.reason === 'COMPLETED') { if (a.kind !== 'CANARY') refuse('CANARY_ONLY', 'COMPLETED is the outcome of a canary authorization'); const entries = Object.values(s.orders).filter((o) => o.kind === 'CANARY_ENTRY'); if (!entries.length) refuse('CANARY_INCOMPLETE', 'no canary entry was dispatched'); if (entries.some((o) => !TERMINAL_ORDER_STATES.includes(o.state))) refuse('CANARY_INCOMPLETE', 'a canary entry is not terminal'); if (Object.values(s.orders).some((o) => o.state === 'DISPATCH_UNCERTAIN')) refuse('CANARY_INCOMPLETE', 'an uncertain dispatch is unresolved'); if (entries.some((o) => s.positions[o.positionId] && s.positions[o.positionId].state !== 'FLAT')) refuse('CANARY_INCOMPLETE', 'the canary position is not flat'); s.canaryEvidence = { authorizationId: a.authorizationId, releaseDigest: a.releaseDigest, policyDigest: a.policyDigest, codeDigest: a.codeDigest, completedTs: p.ts, entries: entries.length, filled: entries.filter((o) => o.state === 'FILLED').length }; }
    a.ended = true; a.endedReason = p.reason; if (s.authorization?.authorizationId === p.authorizationId) { s.authorization = a; if (s.mode === 'LIVE_ARMED') s.mode = 'REDUCE_ONLY'; } },
  HYPOTHESIS_LOCKED(s, p) { if (s.hypotheses[p.decisionId]) refuse('HYPOTHESIS_DUPLICATE', p.decisionId); if (p.expiresTs <= p.triggerTs) refuse('HYPOTHESIS_EXPIRY', 'expiry must follow the trigger'); s.hypotheses[p.decisionId] = { ...p, valuationAfterLock: null }; },
  DECISION_RECORDED(s, p, ev) {
    if (s.decisions[p.decisionId]) refuse('DECISION_DUPLICATE', p.decisionId);
    if (p.sizing !== null) { const h = s.hypotheses[p.decisionId] ?? refuse('PRICE_BLIND_LAW', 'a sized decision needs its hypothesis locked first'); if (h.frozenAtTs > p.decisionKnownAtTs) refuse('PRICE_BLIND_LAW', 'valuation precedes the hypothesis lock'); h.valuationAfterLock = true; if (h.episodeId !== p.episodeId) refuse('EPISODE_MISMATCH', 'decision episode differs from the locked hypothesis'); }
    if ((p.state === 'ENTRY_PROPOSED' || p.state === 'ENTRY_RESERVED') && p.sizing === null) refuse('SIZING_REQUIRED', `${p.state} needs a size`);
    s.decisions[p.decisionId] = { ...p, recordedTs: ev.knownAtTs }; pushBounded(s.decisionOrder, p.decisionId, MAX_RECENT); for (const id of Object.keys(s.decisions)) if (!s.decisionOrder.includes(id)) delete s.decisions[id];
    s.counters.decisions[p.state] = (s.counters.decisions[p.state] ?? 0) + 1;
  },
  RESERVATION_OPENED(s, p, ev) {
    if (s.reservations[p.reservationId]) refuse('RESERVATION_DUPLICATE', p.reservationId);
    const d = s.decisions[p.decisionId] ?? refuse('DECISION_UNKNOWN', p.decisionId); if (d.sizing === null) refuse('SIZING_REQUIRED', 'reservation needs a sized decision'); if (d.assetId !== p.assetId) refuse('ASSET_MISMATCH', 'reservation asset differs from the decision');
    if (Object.values(s.reservations).some((r) => r.decisionId === p.decisionId && r.state === 'OPEN')) refuse('RESERVATION_DUPLICATE', 'one open reservation per decision');
    const blocking = entryBlockingRestrictions(s); if (blocking.length) refuse('ENTRY_RESTRICTED', blocking.join(','));
    if (!['PAPER', 'REPLAY', 'LIVE_ARMED'].includes(s.mode)) refuse('MODE_FORBIDS_ENTRY', s.mode);
    if (s.mode === 'LIVE_ARMED' && !authorizationActive(s, ev.knownAtTs)) refuse('ARM_EXPIRED', 'no unexpired live authorization');
    if (s.valuation.unknown) refuse('VALUATION_UNKNOWN', 'equity / risk unknown: no additions');
    if (M.lt(availableCash(s), p.cashReserved)) refuse('CASH_INSUFFICIENT', `available ${availableCash(s)} < ${p.cashReserved} (fees and pending reservations must fit inside the balance)`);
    const remaining = allocationRemaining(s, ev.knownAtTs); if (remaining !== null && M.gt(p.cashReserved, remaining)) refuse('ALLOCATION_EXCEEDED', `${p.cashReserved} > remaining allocation ${remaining} (ceiling ${s.authorization.allocationCeiling}, reinvestment ${s.authorization.reinvestment})`);
    const asset = new Set([...heldPositions(s).filter((x) => x.state !== 'DUST_UNRESOLVED').map((x) => x.assetId), ...openReservations(s).map((r) => r.assetId)]);
    if (asset.has(p.assetId)) refuse('ASSET_ALREADY_HELD', `one open position / reservation per underlying (${p.assetId})`);
    if (s.limits && slotsUsed(s) >= s.limits.maxSimultaneousAssetPositions) refuse('SLOTS_EXHAUSTED', `${slotsUsed(s)} of ${s.limits.maxSimultaneousAssetPositions} slots used`);
    if (s.limits && s.performance.riskPerformanceEquity !== null) { const base = s.performance.riskPerformanceEquity; const perPos = M.mul(base, M.fromStatistic(s.limits.maxModelledRiskPerPositionFraction, 6)); const agg = M.mul(base, M.fromStatistic(s.limits.maxAggregateModelledRiskFraction, 6)); if (M.gt(p.riskReserved, perPos)) refuse('RISK_PER_POSITION', `${p.riskReserved} > ${perPos}`); const open = M.add(reservedRisk(s), M.sum(heldPositions(s).map((x) => x.riskReserved ?? '0'))); if (M.gt(M.add(open, p.riskReserved), agg)) refuse('RISK_AGGREGATE', `${M.add(open, p.riskReserved)} > ${agg}`); }
    s.reservations[p.reservationId] = { ...p, state: 'OPEN', openedTs: ev.knownAtTs, orderId: null };
  },
  RESERVATION_RELEASED(s, p) {
    const r = s.reservations[p.reservationId] ?? refuse('RESERVATION_UNKNOWN', p.reservationId); if (r.state !== 'OPEN') refuse('RESERVATION_NOT_OPEN', `already ${r.state} (release exactly once)`);
    if (M.gt(p.releasedCash, r.cashReserved) || M.gt(p.releasedRisk, r.riskReserved)) refuse('RELEASE_EXCEEDS', 'cannot release more than reserved');
    if (r.orderId) { const o = s.orders[r.orderId]; if (o && !TERMINAL_ORDER_STATES.includes(o.state)) refuse('RELEASE_WHILE_ORDER_OPEN', `order ${r.orderId} is ${o.state}: an ambiguous order is not refunded`); if (o && o.state === 'REJECTED' && !o.guaranteesNoAcceptance) refuse('RELEASE_AMBIGUOUS_REJECTION', 'rejection without a no-acceptance guarantee keeps the reservation'); }
    else if (['CANCELLED_UNSENT', 'EXPIRED', 'REFUSED_AT_REVALIDATION'].includes(p.reason) === false && p.reason !== 'CONSUMED') refuse('RELEASE_REASON', `${p.reason} needs an order`);
    r.state = p.reason === 'CONSUMED' || p.reason === 'ORDER_TERMINAL' ? 'CONSUMED' : 'RELEASED'; r.releasedCash = p.releasedCash; r.releasedRisk = p.releasedRisk; r.releaseReason = p.reason;
  },
  ORDER_INTENT(s, p, ev) {
    if (s.orders[p.orderId]) refuse('ORDER_DUPLICATE', p.orderId);
    if (Object.values(s.orders).some((o) => o.clientOrderId === p.clientOrderId)) refuse('CLIENT_ID_DUPLICATE', p.clientOrderId);
    const pos = positionOf(s, p.positionId);
    if (p.kind === 'ENTRY' || p.kind === 'CANARY_ENTRY') {
      if (p.side !== 'buy') refuse('ENTRY_SIDE', 'entries are long spot buys'); if (p.orderType !== 'limit' || p.timeInForce !== 'IOC' || p.limitPrice === null) refuse('ENTRY_ORDER_FORM', 'entry is a marketable IOC limit with an explicit worst price');
      if (p.protection === null) refuse('NAKED_ENTRY', 'no naked buy: the conditional protection template is required'); if (!M.lt(p.protection.price, p.limitPrice)) refuse('PROTECTION_ABOVE_ENTRY', 'stop trigger must be below the entry price');
      const r = s.reservations[p.reservationId ?? ''] ?? refuse('RESERVATION_REQUIRED', 'entry needs its open reservation'); if (r.state !== 'OPEN') refuse('RESERVATION_NOT_OPEN', r.state); if (r.orderId) refuse('RESERVATION_ALREADY_BOUND', r.orderId); if (r.assetId !== pos.assetId || pos.decisionId !== r.decisionId) refuse('RESERVATION_POSITION_MISMATCH', 'reservation and position disagree');
      if (pos.state !== 'SHELL') refuse('POSITION_NOT_SHELL', pos.state); if (!pos.feedPinned) refuse('FEED_PIN_REQUIRED', 'capacity pin before entry');
      const worst = M.add(M.mul(p.qty, p.limitPrice), '0'); if (M.gt(worst, r.cashReserved)) refuse('INTENT_EXCEEDS_RESERVATION', `${worst} > reserved ${r.cashReserved}`);
      const dz = s.decisions[r.decisionId]?.sizing ?? null; if (dz && (M.gt(p.limitPrice, dz.entryLimitPrice) || M.gt(p.qty, dz.q))) refuse('LIMIT_ABOVE_DECISION', `limit ${p.limitPrice} / qty ${p.qty} exceed the recorded decision (${dz.entryLimitPrice} / ${dz.q}); a cap can tighten, never rise`);
      const blocking = entryBlockingRestrictions(s); if (blocking.length) refuse('ENTRY_RESTRICTED', blocking.join(','));
      if (p.kind === 'CANARY_ENTRY') { if (!authorizationActive(s, ev.knownAtTs) || s.authorization.kind !== 'CANARY') refuse('CANARY_UNAUTHORIZED', 'canary needs its own active authorization'); const cb = s.authorization.canary; if (!cb || cb.pair !== p.pair) refuse('CANARY_BOUNDS', `canary authorized for ${cb?.pair ?? 'no pair'}, not ${p.pair}`); if (M.gt(r.cashReserved, cb.maxBuyConsiderationWithFees)) refuse('CANARY_BOUNDS', `consideration ${r.cashReserved} exceeds the canary ceiling ${cb.maxBuyConsiderationWithFees}`); if (Object.values(s.orders).some((o) => o.kind === 'CANARY_ENTRY' && o.orderId !== p.orderId)) refuse('CANARY_BOUNDS', 'one canary entry per authorization'); }
      if (p.kind === 'ENTRY' && s.accountKind === 'LIVE' && (!authorizationActive(s, ev.knownAtTs) || s.authorization.kind !== 'LIVE_ARM')) refuse('ARM_REQUIRED', 'live entry needs an active LIVE_ARM authorization');
      r.orderId = p.orderId; pos.state = 'PENDING_ENTRY'; pos.pendingEntryBase = p.qty; pos.entryOrderId = p.orderId; pos.protectionTemplate = p.protection; pos.protection.state = 'TEMPLATE_READY';
    } else {
      if (p.side !== 'sell') refuse('EXIT_SIDE', 'exits sell'); if (!['OPEN', 'EXITING', 'PENDING_ENTRY', 'DUST_UNRESOLVED', 'UNRESOLVED'].includes(pos.state)) refuse('POSITION_NOT_OPEN', pos.state);
      if (p.kind === 'PROTECTIVE_STOP') { if (p.orderType !== 'stop-loss') refuse('STOP_FORM', 'protective stop is a stop-loss'); }
      else { if (['ACTIVE', 'PENDING', 'AMEND_PENDING', 'CANCEL_PENDING', 'TEMPLATE_READY'].includes(pos.protection.state) && pos.protection.orderId && s.orders[pos.protection.orderId] && !TERMINAL_ORDER_STATES.includes(s.orders[pos.protection.orderId].state)) refuse('COMPETING_SELL', `protection ${pos.protection.state}: cancel and confirm before selling the same inventory`); if (pos.protection.state === 'ACTIVE' || pos.protection.state === 'PENDING' || pos.protection.state === 'AMEND_PENDING' || pos.protection.state === 'CANCEL_PENDING') refuse('COMPETING_SELL', `protection ${pos.protection.state}`); }
      const openSells = Object.values(s.orders).filter((o) => o.positionId === p.positionId && o.side === 'sell' && !TERMINAL_ORDER_STATES.includes(o.state)); const locked = M.sum(openSells.map((o) => M.sub(o.qty, o.filledBase)));
      const available = M.sub(ownedBase(pos), locked); if (M.gt(p.qty, available)) refuse('OVERSELL', `sell ${p.qty} > available-to-exit ${available} (owned ${ownedBase(pos)} minus locked ${locked})`);
      if (p.kind === 'PROTECTIVE_STOP') { const children = { ...(pos.protection.children ?? {}) }; children[p.orderId] = { orderId: p.orderId, nativeOrderId: null, state: 'PENDING', trigger: p.limitPrice, qty: p.qty, confirmedTs: null, filledBase: '0', pendingAmend: null, reason: null, ts: ev.knownAtTs }; pos.protection = deriveProtection(s, pos, { ...pos.protection, children, unbound: null }, ev.knownAtTs); } else pos.state = 'EXITING';
    }
    s.orders[p.orderId] = { ...p, state: 'UNSENT', filledBase: '0', filledQuote: '0', feesQuote: '0', feesBase: '0', attempts: [], nativeOrderId: null, priorState: null, guaranteesNoAcceptance: false, terminalTs: null, mismatch: null };
  },
  DISPATCH_ATTEMPTED(s, p) { const o = orderOf(s, p.orderId); if (o.state !== 'UNSENT') refuse('DISPATCH_NOT_UNSENT', `${o.state}: never blind-resubmit`); if (o.attempts.length) refuse('DISPATCH_REPEATED', 'one dispatch attempt per order intent'); o.attempts.push({ attemptId: p.attemptId, ts: p.ts, adapter: p.adapter, outcome: null }); o.state = 'DISPATCH_UNCERTAIN'; },
  DISPATCH_RESULT(s, p) {
    const o = orderOf(s, p.orderId); const a = o.attempts.find((x) => x.attemptId === p.attemptId) ?? refuse('ATTEMPT_UNKNOWN', p.attemptId); if (a.outcome) refuse('ATTEMPT_RESOLVED', 'attempt already resolved'); a.outcome = p.outcome; a.receiptTs = p.receiptTs;
    if (p.nativeOrderId) o.nativeOrderId = p.nativeOrderId;
    if (o.kind === 'PROTECTIVE_STOP') { const pos = positionOf(s, o.positionId); const child = (pos.protection.children ?? {})[o.orderId]; if (child) { if (p.nativeOrderId) child.nativeOrderId = p.nativeOrderId; if (p.outcome === 'REJECTED') child.state = 'FAILED'; pos.protection = deriveProtection(s, pos, pos.protection, p.receiptTs); } }
    if (p.outcome === 'ACKNOWLEDGED') { if (o.state === 'DISPATCH_UNCERTAIN') o.state = M.isZero(o.filledBase) ? 'ACKNOWLEDGED' : M.eq(o.filledBase, o.qty) ? 'FILLED' : 'PARTIALLY_FILLED'; }
    else if (p.outcome === 'REJECTED') { if (!M.isZero(o.filledBase)) refuse('REJECTED_WITH_FILLS', 'a rejected order cannot carry fills: reconcile'); o.state = 'REJECTED'; o.guaranteesNoAcceptance = p.guaranteesNoAcceptance; o.terminalTs = p.receiptTs; settleEntryTerminal(s, o); }
    else { /* UNCERTAIN: stays DISPATCH_UNCERTAIN until reconciliation resolves it */ o.uncertainReason = p.reason; }
  },
  EXECUTION_RECORDED(s, p, ev) {
    const key = `${s.venue}|${p.execId}`; const seen = s.execIds[key];
    const content = digestOf({ base: p.base, quote: p.quote, price: p.price, side: p.side, orderId: p.orderId, nativeOrderId: p.nativeOrderId, fee: p.fee });
    if (seen) { if (seen === content) { refuse('DUPLICATE_EXECUTION', p.execId); } refuse('EXECUTION_IDENTITY_CONFLICT', `${p.execId} repeated with different content: integrity locked`); }
    if (p.orderId === null) refuse('EXECUTION_UNMATCHED', 'an unmatched native execution is EXTERNAL_ACTIVITY, never attributed to a convenient strategy');
    const o = orderOf(s, p.orderId); const pos = positionOf(s, o.positionId); if (o.side !== p.side) refuse('EXECUTION_SIDE', 'fill side differs from the order');
    if (o.nativeOrderId && p.nativeOrderId && o.nativeOrderId !== p.nativeOrderId) refuse('EXECUTION_ORDER_MISMATCH', 'native order id differs'); if (!o.nativeOrderId && p.nativeOrderId) o.nativeOrderId = p.nativeOrderId;
    const totalFilled = M.add(o.filledBase, p.base); if (M.gt(totalFilled, o.qty)) refuse('OVERFILL', `${totalFilled} > order qty ${o.qty}`);
    const assetOf = pos.assetId; const { quoteFee, baseFee, otherFee } = feeParts(p.fee, s.quote, assetOf);
    if (p.side === 'buy') { const debit = M.add(p.quote, quoteFee); if (M.lt(s.cash, debit) && s.accountKind !== 'LIVE') refuse('CASH_NEGATIVE', `paper fill would overdraw cash ${s.cash} by ${debit}`); s.cash = M.sub(s.cash, debit); pos.confirmedBase = M.add(pos.confirmedBase, p.base); pos.entryQuote = M.add(pos.entryQuote, p.quote); pos.entryFeesQuote = M.add(pos.entryFeesQuote, quoteFee); pos.pendingEntryBase = M.max('0', M.sub(pos.pendingEntryBase ?? '0', p.base)); if (pos.firstFillTs === null) { pos.firstFillTs = p.sourceTs ?? p.receiptTs; pos.firstFillReceiptTs = p.receiptTs; pos.durationDeadlineTs = pos.firstFillTs + pos.maxDurationMs; } else if (p.sourceTs !== null && p.sourceTs < pos.firstFillTs) { pos.firstFillTs = p.sourceTs; pos.durationDeadlineTs = p.sourceTs + pos.maxDurationMs; } if (pos.state === 'PENDING_ENTRY' || pos.state === 'SHELL') pos.state = 'OPEN'; }
    else { if (M.gt(p.base, ownedBase(pos))) refuse('OVERSELL', `sell fill ${p.base} exceeds owned ${ownedBase(pos)}`); s.cash = M.add(s.cash, M.sub(p.quote, quoteFee)); pos.soldBase = M.add(pos.soldBase, p.base); pos.exitQuote = M.add(pos.exitQuote, p.quote); pos.exitFeesQuote = M.add(pos.exitFeesQuote, quoteFee); }
    pos.baseFees = M.add(pos.baseFees, baseFee); if (otherFee) { pos.otherFees.push({ execId: p.execId, ...otherFee }); pos.pnlUnknown = true; }
    s.realized.fees = M.add(s.realized.fees, quoteFee); if (!M.isZero(baseFee)) s.realized.baseFees[assetOf] = M.add(s.realized.baseFees[assetOf] ?? '0', baseFee);
    o.filledBase = totalFilled; o.filledQuote = M.add(o.filledQuote, p.quote); o.feesQuote = M.add(o.feesQuote, quoteFee); o.feesBase = M.add(o.feesBase, baseFee); o.lastExecTs = p.receiptTs;
    if (!TERMINAL_ORDER_STATES.includes(o.state)) o.state = M.eq(totalFilled, o.qty) ? 'FILLED' : 'PARTIALLY_FILLED'; else o.lateFills = (o.lateFills ?? 0) + 1;
    if (o.state === 'FILLED' && o.terminalTs === null) { o.terminalTs = p.receiptTs; settleEntryTerminal(s, o); }
    if (o.kind === 'PROTECTIVE_STOP') { const child = (pos.protection.children ?? {})[o.orderId]; if (child) { child.filledBase = totalFilled; if (M.eq(totalFilled, o.qty)) child.state = 'TRIGGERED'; } pos.protection = deriveProtection(s, pos, pos.protection, p.receiptTs); }
    pos.executions.push({ execId: p.execId, side: p.side, base: p.base, quote: p.quote, price: p.price, fee: p.fee, sourceTs: p.sourceTs, receiptTs: p.receiptTs, origin: p.origin, orderId: p.orderId }); if (pos.executions.length > 512) pos.executions.splice(0, pos.executions.length - 512);
    s.execIds[key] = content; s.execOrder.push(key);
    s.counters.fills += 1; pos.lastEconomicTs = ev.knownAtTs; recomputeRealized(s, pos);
  },
  ORDER_STATE(s, p) {
    const o = orderOf(s, p.orderId); if (p.nativeOrderId) { if (o.nativeOrderId && o.nativeOrderId !== p.nativeOrderId) refuse('NATIVE_ID_MISMATCH', 'order id differs'); o.nativeOrderId = p.nativeOrderId; }
    if (p.nativeCumQty !== null && !M.eq(p.nativeCumQty, o.filledBase)) { if (p.state !== 'RECONCILIATION_REQUIRED') refuse('CUM_QTY_MISMATCH', `native cumulative ${p.nativeCumQty} != recorded ${o.filledBase}: cumulative totals are checks, not fills — reconcile`); o.mismatch = { nativeCumQty: p.nativeCumQty, recorded: o.filledBase }; }
    if (p.state === 'FILLED' && !M.eq(o.filledBase, o.qty)) refuse('FILLED_WITHOUT_EXECUTIONS', `${o.filledBase} of ${o.qty} recorded: a FILLED status is not a fill`);
    if (TERMINAL_ORDER_STATES.includes(o.state) && o.state !== p.state && p.state !== 'RECONCILIATION_REQUIRED') refuse('ORDER_TERMINAL', `${o.state} -> ${p.state} refused (late messages reconcile, never erase)`);
    if (p.state === 'RECONCILIATION_REQUIRED') { o.reconcileReason = p.reason; s.restrictions.RECONCILIATION_REQUIRED = { ts: p.receiptTs, source: 'reducer', reason: `order ${p.orderId}: ${p.reason ?? 'state uncertain'}` }; }
    if (['PARTIALLY_FILLED', 'FILLED'].includes(p.state) && o.state === 'CANCEL_PENDING') { /* cancel race: fills won */ }
    o.state = p.state; if (TERMINAL_ORDER_STATES.includes(p.state) && o.terminalTs === null) { o.terminalTs = p.receiptTs; settleEntryTerminal(s, o); }
    if (o.kind === 'PROTECTIVE_STOP') { const pos = positionOf(s, o.positionId); const child = (pos.protection.children ?? {})[o.orderId]; if (child) { if (p.state === 'CANCELLED' || p.state === 'EXPIRED') child.state = 'CANCELLED'; if (p.state === 'REJECTED') child.state = 'FAILED'; if (p.state === 'RECONCILIATION_REQUIRED') child.state = 'MISMATCH'; if (p.state === 'FILLED') child.state = 'TRIGGERED'; if (p.nativeOrderId && !child.nativeOrderId) child.nativeOrderId = p.nativeOrderId; } pos.protection = deriveProtection(s, pos, pos.protection, p.receiptTs); }
  },
  CANCEL_REQUESTED(s, p) { const o = orderOf(s, p.orderId); if (TERMINAL_ORDER_STATES.includes(o.state)) refuse('ORDER_TERMINAL', o.state); if (o.state === 'CANCEL_PENDING') refuse('CANCEL_PENDING', 'one unresolved cancel per order (no churn)'); o.priorState = o.state; o.state = 'CANCEL_PENDING'; o.cancelAttempts = [...(o.cancelAttempts ?? []), { attemptId: p.attemptId, ts: p.ts, outcome: null }]; if (o.kind === 'PROTECTIVE_STOP') { const pos = positionOf(s, o.positionId); const child = (pos.protection.children ?? {})[o.orderId]; if (child) child.state = 'CANCEL_PENDING'; pos.protection = deriveProtection(s, pos, pos.protection, p.ts); } },
  CANCEL_RESULT(s, p) {
    const o = orderOf(s, p.orderId); const a = (o.cancelAttempts ?? []).find((x) => x.attemptId === p.attemptId) ?? refuse('ATTEMPT_UNKNOWN', p.attemptId); if (a.outcome) refuse('ATTEMPT_RESOLVED', 'cancel attempt already resolved'); a.outcome = p.outcome;
    const pos = positionOf(s, o.positionId);
    const child = o.kind === 'PROTECTIVE_STOP' ? (pos.protection.children ?? {})[o.orderId] ?? null : null;
    if (p.outcome === 'CANCELLED') { o.state = TERMINAL_ORDER_STATES.includes(o.state) ? o.state : 'CANCELLED'; if (o.terminalTs === null) { o.terminalTs = p.receiptTs; settleEntryTerminal(s, o); } if (child) child.state = child.state === 'TRIGGERED' || (child.filledBase && M.eq(child.filledBase, child.qty ?? '-1')) ? 'TRIGGERED' : 'CANCELLED'; }
    else if (p.outcome === 'REJECTED') { o.state = o.priorState ?? 'ACKNOWLEDGED'; if (child) child.state = 'ACTIVE'; }
    else if (p.outcome === 'ALREADY_TERMINAL') { if (!TERMINAL_ORDER_STATES.includes(o.state)) { o.state = 'RECONCILIATION_REQUIRED'; s.restrictions.RECONCILIATION_REQUIRED = { ts: p.receiptTs, source: 'reducer', reason: `order ${p.orderId} terminal at venue but not recorded` }; if (child) child.state = 'MISMATCH'; } }
    else { o.state = 'RECONCILIATION_REQUIRED'; s.restrictions.RECONCILIATION_REQUIRED = { ts: p.receiptTs, source: 'reducer', reason: `cancel of ${p.orderId} uncertain` }; if (child) child.state = 'MISMATCH'; }
    if (o.kind === 'PROTECTIVE_STOP') pos.protection = deriveProtection(s, pos, pos.protection, p.receiptTs);
  },
  // protection is a SET of confirmed native children (closeout R04): each child is keyed by its journal PROTECTIVE_STOP order
  // (or by its native id until the dispatcher books one); coverage counts ONLY confirmed (ACTIVE / AMEND_PENDING) children;
  // PENDING is not ACTIVE; under- or over-coverage of owned base is MISMATCH (PROTECTION_MISMATCH latched); the aggregate
  // fields (state / orderId / nativeOrderId / trigger / qty) summarise the set for the Watch and the projection.
  PROTECTION_STATE(s, p) {
    const pos = positionOf(s, p.positionId); const prot = pos.protection; const children = prot.children ?? {};
    const key = childKey(prot, p); const prev = key ? children[key] ?? null : null;
    if (p.state === 'ACTIVE') { if (p.qty === null || p.trigger === null) refuse('PROTECTION_FACTS', 'ACTIVE needs confirmed qty and trigger'); if (prev && prev.state === 'ACTIVE' && prev.trigger && M.lt(p.trigger, prev.trigger)) refuse('PROTECTION_LOOSENED', `trigger ${p.trigger} below confirmed ${prev.trigger}`); }
    if (key) children[key] = { ...(prev ?? { filledBase: '0', pendingAmend: null }), orderId: p.orderId ?? prev?.orderId ?? null, nativeOrderId: p.nativeOrderId ?? prev?.nativeOrderId ?? null, state: p.state, trigger: p.trigger ?? prev?.trigger ?? null, qty: p.qty ?? prev?.qty ?? null, confirmedTs: p.state === 'ACTIVE' ? p.receiptTs : prev?.confirmedTs ?? null, reason: p.reason ?? null, ts: p.receiptTs };
    else prot.unbound = p.state === 'PENDING' ? { trigger: p.trigger, qty: p.qty, ts: p.receiptTs } : null;
    if (p.state === 'MISMATCH' || p.state === 'FAILED') s.restrictions.PROTECTION_MISMATCH = { ts: p.receiptTs, source: 'reducer', reason: `position ${p.positionId}: ${p.reason ?? p.state}` };
    pos.protection = deriveProtection(s, pos, { ...prot, children }, p.receiptTs);
  },
  PROTECTION_AMEND(s, p) {
    const pos = positionOf(s, p.positionId); const prot = pos.protection; const child = (prot.children ?? {})[p.orderId] ?? null; if (!child) refuse('PROTECTION_ORDER_MISMATCH', 'amend names an order that is not a protective child of this position');
    if (p.outcome === 'REQUESTED') { if (child.state !== 'ACTIVE') refuse('AMEND_NOT_ACTIVE', child.state); if (child.pendingAmend) refuse('AMEND_PENDING', 'one unresolved amendment per child stop'); if (child.trigger && !M.gt(p.requestedTrigger, child.trigger)) refuse('AMEND_NOT_TIGHTER', `${p.requestedTrigger} does not tighten ${child.trigger}`); child.pendingAmend = { amendId: p.amendId, requestedTrigger: p.requestedTrigger, ts: p.receiptTs }; child.state = 'AMEND_PENDING'; pos.protection = deriveProtection(s, pos, prot, p.receiptTs); return; }
    const pend = child.pendingAmend; if (!pend || pend.amendId !== p.amendId) refuse('AMEND_STALE', 'a stale amend response cannot overwrite newer confirmed state');
    if (p.outcome === 'ACKNOWLEDGED') { if (p.confirmedTrigger === null || M.lt(p.confirmedTrigger, child.trigger ?? '0')) refuse('AMEND_CONFIRMATION', 'acknowledgement must confirm a tighter trigger'); child.trigger = p.confirmedTrigger; child.state = 'ACTIVE'; child.pendingAmend = null; child.lastAmendTs = p.receiptTs; }
    else if (p.outcome === 'FAILED') { child.state = 'ACTIVE'; child.pendingAmend = null; }
    else { child.state = 'MISMATCH'; child.pendingAmend = null; s.restrictions.RECONCILIATION_REQUIRED = { ts: p.receiptTs, source: 'reducer', reason: `amend ${p.amendId} uncertain` }; }
    pos.protection = deriveProtection(s, pos, prot, p.receiptTs);
  },
  POSITION_OPENED(s, p, ev) {
    if (s.positions[p.positionId]) refuse('POSITION_DUPLICATE', p.positionId); const d = s.decisions[p.decisionId] ?? refuse('DECISION_UNKNOWN', p.decisionId); if (d.assetId !== p.assetId) refuse('ASSET_MISMATCH', 'position asset differs from decision');
    if (heldPositions(s).some((x) => x.assetId === p.assetId && x.state !== 'DUST_UNRESOLVED')) refuse('ASSET_ALREADY_HELD', p.assetId);
    if (p.targetPrice !== null && !M.gt(p.targetPrice, p.structuralStop)) refuse('GEOMETRY', 'target must exceed the stop');
    s.positions[p.positionId] = { ...p, state: 'SHELL', confirmedBase: '0', pendingEntryBase: '0', soldBase: '0', baseFees: '0', entryQuote: '0', entryFeesQuote: '0', exitQuote: '0', exitFeesQuote: '0', otherFees: [], executions: [], firstFillTs: null, firstFillReceiptTs: null, durationDeadlineTs: null, entryOrderId: null, protectionTemplate: null, protection: { state: 'NONE', orderId: null, nativeOrderId: null, trigger: null, qty: null, confirmedTs: null, pendingAmend: null, children: {}, coverage: '0', unbound: null }, initialR: { state: 'PROVISIONAL', value: null, entryVwap: null, entryCashOut: null }, riskReserved: null, trailActive: false, highestBid: null, exit: { state: 'NONE', primaryReason: null, priority: null }, realizedPnl: null, pnlUnknown: false, openedTs: ev.knownAtTs, closedTs: null, dust: null };
  },
  POSITION_R(s, p) { const pos = positionOf(s, p.positionId); if (p.state === 'FINAL') { if (p.initialR === null || !M.isPositive(p.initialR)) refuse('R_FINAL_INVALID', 'FINAL R must be positive'); if (!M.eq(p.confirmedBase, pos.confirmedBase)) refuse('R_BASE_MISMATCH', `${p.confirmedBase} != confirmed ${pos.confirmedBase}`); const eo = pos.entryOrderId ? s.orders[pos.entryOrderId] : null; if (eo && !TERMINAL_ORDER_STATES.includes(eo.state)) refuse('R_ENTRY_OPEN', 'R is PROVISIONAL until the entry IOC is terminal'); } if (pos.initialR.state === 'FINAL' && p.state === 'PROVISIONAL') refuse('R_REGRESSION', 'FINAL R cannot become provisional; append a correction'); pos.initialR = { state: p.state, value: p.initialR, entryVwap: p.entryVwap, entryCashOut: p.entryCashOut, ts: p.ts, reason: p.reason, targetPerUnit: p.targetPerUnit ?? null }; if (p.state === 'FINAL') pos.riskReserved = p.initialR; },
  WATCH_STATE(s, p) { const pos = positionOf(s, p.positionId); if (pos.trailActive && !p.trailActive) refuse('TRAIL_REGRESSION', 'trailActive latches durably'); if (p.trailActive && pos.initialR.state !== 'FINAL') refuse('TRAIL_PROVISIONAL_R', 'the trail needs FINAL positive R'); if (pos.highestBid && p.highestBid && M.lt(p.highestBid, pos.highestBid)) refuse('HIGHEST_BID_REGRESSION', 'highest accepted bid never decreases'); pos.trailActive = p.trailActive; pos.highestBid = p.highestBid ?? pos.highestBid; pos.exit = { state: p.exitState, primaryReason: p.primaryReason, priority: p.priority, supportedReasons: p.supportedReasons, ts: p.ts }; },
  POSITION_CLOSED(s, p) {
    const pos = positionOf(s, p.positionId); const residual = ownedBase(pos); if (!M.eq(residual, p.residualBase)) refuse('RESIDUAL_MISMATCH', `recorded residual ${residual} != ${p.residualBase}`);
    const openOrders = Object.values(s.orders).filter((o) => o.positionId === p.positionId && !TERMINAL_ORDER_STATES.includes(o.state));
    if (p.state === 'FLAT') { if (!M.isZero(residual)) refuse('NOT_FLAT', `residual ${residual}`); if (openOrders.length) refuse('NOT_FLAT', `open orders ${openOrders.map((o) => o.orderId).join(',')}`); if (['ACTIVE', 'PENDING', 'AMEND_PENDING', 'CANCEL_PENDING', 'MISMATCH'].includes(pos.protection.state) || Object.values(pos.protection.children ?? {}).some((c) => ['PENDING', 'ACTIVE', 'AMEND_PENDING', 'CANCEL_PENDING', 'MISMATCH'].includes(c.state))) refuse('ORPHAN_PROTECTION', `protection ${pos.protection.state} must be cancelled and confirmed before FLAT (every child terminal)`); if (!M.isZero(pos.pendingEntryBase) && pos.entryOrderId && !TERMINAL_ORDER_STATES.includes(s.orders[pos.entryOrderId]?.state)) refuse('ENTRY_PENDING', 'entry remainder unresolved'); }
    if (p.state === 'DUST_UNRESOLVED' && M.isZero(residual)) refuse('DUST_ZERO', 'no residual to call dust');
    pos.state = p.state; pos.closedTs = p.ts; pos.closeReason = p.reason; if (p.state === 'FLAT') { pos.riskReserved = '0'; pos.feedPinned = false; }
    recomputeRealized(s, pos);
  },
  RECONCILIATION(s, p) { s.lastReconciliation = { ...p }; if (p.outcome === 'COMPLETE' && p.unmatched === 0 && !p.pageIncomplete) { const anyMismatch = Object.values(s.orders).some((o) => o.state === 'RECONCILIATION_REQUIRED') || Object.values(s.positions).some((x) => x.protection.state === 'MISMATCH'); if (!anyMismatch) delete s.restrictions.RECONCILIATION_REQUIRED; } else s.restrictions.RECONCILIATION_REQUIRED = s.restrictions.RECONCILIATION_REQUIRED ?? { ts: p.ts, source: 'reconciliation', reason: p.reason ?? p.outcome }; },
  EXTERNAL_ACTIVITY(s, p) { pushBounded(s.externalActivity, { ...p }, MAX_EXTERNAL); s.counters.externalActivity += 1; if (p.kind === 'WITHDRAWAL' || p.kind === 'DEPOSIT' || p.kind === 'BALANCE_MISMATCH' || p.kind === 'FILL') { s.flowsUnknown = true; s.valuation = { ...s.valuation, unknown: true, reason: `external ${p.kind} unreconciled` }; s.restrictions.RECONCILIATION_REQUIRED = s.restrictions.RECONCILIATION_REQUIRED ?? { ts: p.receiptTs, source: 'external', reason: `${p.kind} ${p.ref}` }; } },
  EXTERNAL_FLOW_ADMITTED(s, p) { if (Object.values(s.externalActivity).some((x) => x.flowId === p.flowId)) refuse('FLOW_DUPLICATE', p.flowId); const signed = p.direction === 'DEPOSIT' ? p.valuedUsd : M.neg(p.valuedUsd); if (p.asset === s.quote) { if (p.direction === 'WITHDRAWAL' && M.lt(availableCash(s), p.amount)) refuse('WITHDRAWAL_EXCEEDS_CASH', 'cannot withdraw reserved / absent cash'); s.cash = M.add(s.cash, p.direction === 'DEPOSIT' ? p.amount : M.neg(p.amount)); } s.externalFlows = M.add(s.externalFlows, signed); s.flowsUnknown = false; pushBounded(s.externalActivity, { kind: p.direction, ref: p.flowId, asset: p.asset, amount: p.amount, flowId: p.flowId, admitted: true, receiptTs: p.ts }, MAX_EXTERNAL); },
  RESTRICTION(s, p) {
    if (p.action === 'LATCH') { if (p.code === 'VETO') { if (!p.scope) refuse('VETO_SCOPE', 'veto needs a scope'); if (!s.vetoes.includes(p.scope)) s.vetoes.push(p.scope); return; } s.restrictions[p.code] = { ts: p.ts, source: p.source, reason: p.reason, sessionDate: p.sessionDate, scope: p.scope }; if (p.code === 'KILL' && ['LIVE_ARMED', 'PAPER', 'REPLAY'].includes(s.mode)) s.mode = 'REDUCE_ONLY'; return; }
    if (p.code === 'VETO') { s.vetoes = s.vetoes.filter((v) => v !== p.scope); return; }
    const cur = s.restrictions[p.code]; if (!cur) return;
    if (p.code === 'DAILY_LOSS' && cur.sessionDate === p.sessionDate) refuse('DAILY_LOSS_LATCHED', 'daily loss restriction stays latched through its session');
    if (['KILL', 'PEAK_DRAWDOWN', 'RECONCILIATION_REQUIRED', 'PROTECTION_MISMATCH', 'FEE_BOUND_MISMATCH'].includes(p.code) && !p.ownerRef) refuse('OWNER_CLEAR_REQUIRED', `${p.code} clears only with owner intent`);
    if (p.code === 'RECONCILIATION_REQUIRED' && (Object.values(s.orders).some((o) => o.state === 'RECONCILIATION_REQUIRED') || s.flowsUnknown)) refuse('LIABILITY_UNRESOLVED', 'owner CLEAR does not clear an unresolved economic liability');
    delete s.restrictions[p.code];
  },
  MODE_TRANSITION(s, p, ev) {
    if (s.mode !== p.from) refuse('MODE_FROM_MISMATCH', `${s.mode} != ${p.from}`); const to = p.to;
    if (['LIVE_UNARMED', 'LIVE_ARMED'].includes(to) && s.accountKind !== 'LIVE') refuse('MODE_KIND_MISMATCH', `${s.accountKind} account cannot enter ${to}`);
    if (to === 'PAPER' && s.accountKind !== 'PAPER') refuse('MODE_KIND_MISMATCH', `${s.accountKind} account cannot enter PAPER`);
    if (to === 'REPLAY' && !['REPLAY', 'SHADOW'].includes(s.accountKind)) refuse('MODE_KIND_MISMATCH', `${s.accountKind} account cannot enter REPLAY`);
    if (to === 'LIVE_ARMED') { if (!authorizationActive(s, ev.knownAtTs) || !['LIVE_ARM', 'CANARY'].includes(s.authorization.kind)) refuse('ARM_REQUIRED', 'LIVE_ARMED needs an active LIVE_ARM or CANARY authorization'); if (p.authorizationId !== s.authorization.authorizationId) refuse('ARM_BINDING', 'transition must name the active authorization'); const hard = HARD_RESTRICTIONS.filter((c) => s.restrictions[c]); if (hard.length) refuse('ARM_BLOCKED', hard.join(',')); if (s.valuation.unknown) refuse('ARM_BLOCKED', 'valuation unknown'); }
    if (['PAPER', 'REPLAY'].includes(to) && s.restrictions.KILL) refuse('KILLED', 'a killed account stays reduce-only until owner CLEAR');
    s.mode = to; s.modeReason = p.reason;
  },
  VALUATION(s, p) {
    const sessionChanged = s.performance.session && s.performance.session.date !== p.sessionDate;
    if (p.unknown) { s.valuation = { ts: p.ts, equity: null, cashComponent: p.cashComponent, liquidationComponent: null, unknown: true, reason: p.reason ?? 'UNKNOWN_MARKS' }; return; }
    if (!M.eq(p.cashComponent, s.cash)) refuse('VALUATION_CASH_MISMATCH', `${p.cashComponent} != journal cash ${s.cash}`);
    if (p.equity === null || !M.eq(p.equity, M.add(p.cashComponent, p.liquidationComponent))) refuse('VALUATION_SUM', 'equity must equal cash + liquidation value');
    const E = p.equity; const F = s.externalFlows; const perf = M.sub(E, F);
    if (sessionChanged) { s.performance.session = { date: p.sessionDate, openingEquity: E, openingFlows: F, dayPnl: '0', dayLossFraction: 0 }; if (s.restrictions.DAILY_LOSS && s.restrictions.DAILY_LOSS.sessionDate !== p.sessionDate) delete s.restrictions.DAILY_LOSS; }
    const sess = s.performance.session; const dayPnl = M.sub(M.sub(E, sess.openingEquity), M.sub(F, sess.openingFlows)); const opening = sess.openingEquity;
    const H = M.max(s.performance.highWater ?? perf, perf); const dd = M.isPositive(H) ? M.toStatistic(M.div(M.sub(H, perf), H, 8, 'HALF_UP')) : null;
    const dayLoss = M.isPositive(opening) ? M.toStatistic(M.div(M.neg(dayPnl), opening, 8, 'HALF_UP')) : null;
    s.valuation = { ts: p.ts, equity: E, cashComponent: p.cashComponent, liquidationComponent: p.liquidationComponent, unknown: false, reason: p.reason };
    s.performance = { highWater: H, riskPerformanceEquity: perf, drawdown: dd, session: { ...sess, dayPnl, dayLossFraction: dayLoss } };
    if (s.limits) { if (dayLoss !== null && dayLoss >= s.limits.dailyLossRestrictionFraction && !s.restrictions.DAILY_LOSS) s.restrictions.DAILY_LOSS = { ts: p.ts, source: 'valuation', reason: `day P&L ${dayPnl} on opening ${opening}`, sessionDate: p.sessionDate }; if (dd !== null && dd >= s.limits.peakEquityDrawdownRestrictionFraction && !s.restrictions.PEAK_DRAWDOWN) s.restrictions.PEAK_DRAWDOWN = { ts: p.ts, source: 'valuation', reason: `drawdown ${dd} from high-water ${H}` }; if (!M.isPositive(perf) || !M.isPositive(H)) s.restrictions.PEAK_DRAWDOWN = s.restrictions.PEAK_DRAWDOWN ?? { ts: p.ts, source: 'valuation', reason: 'nonpositive equity / high-water support permits no entry' }; }
    for (const m of p.marks) { const pos = s.positions[m.positionId]; if (pos) pos.lastMark = { ts: p.ts, liquidationValue: m.liquidationValue, base: m.base, snapshotDigest: m.snapshotDigest }; }
  },
  FEE_ADJUSTMENT(s, p) { if (!s.execIds[`${s.venue}|${p.execId}`]) refuse('EXEC_UNKNOWN', p.execId); const akey = `fee|${s.venue}|${p.ref}`; const acontent = digestOf({ execId: p.execId, orderId: p.orderId, asset: p.asset, delta: p.delta }); if (s.adjustments[akey]) { if (s.adjustments[akey] === acontent) refuse('DUPLICATE_ADJUSTMENT', `fee adjustment ${p.ref} already applied`); refuse('ADJUSTMENT_IDENTITY_CONFLICT', `fee adjustment ${p.ref} repeated with different content: integrity locked`); } s.adjustments[akey] = acontent; const o = p.orderId ? orderOf(s, p.orderId) : null; const pos = o ? positionOf(s, o.positionId) : null; if (p.asset === s.quote) { s.cash = M.sub(s.cash, p.delta); s.realized.fees = M.add(s.realized.fees, p.delta); if (pos) { if (o.side === 'buy') pos.entryFeesQuote = M.add(pos.entryFeesQuote, p.delta); else pos.exitFeesQuote = M.add(pos.exitFeesQuote, p.delta); } } else if (pos && p.asset === pos.assetId) { pos.baseFees = M.add(pos.baseFees, p.delta); } else { s.flowsUnknown = true; s.valuation = { ...s.valuation, unknown: true, reason: `fee in ${p.asset} needs a known conversion` }; } if (pos) { pos.feeCorrections = [...(pos.feeCorrections ?? []), { execId: p.execId, asset: p.asset, delta: p.delta, ref: p.ref, ts: p.ts }]; recomputeRealized(s, pos); } },
  INVENTORY_ADJUSTMENT(s, p) { const ikey = `inv|${s.venue}|${p.cause}`; const icontent = digestOf({ positionId: p.positionId, asset: p.asset, delta: p.delta }); if (s.adjustments[ikey]) { if (s.adjustments[ikey] === icontent) refuse('DUPLICATE_ADJUSTMENT', `inventory adjustment ${p.cause} already applied`); refuse('ADJUSTMENT_IDENTITY_CONFLICT', `inventory adjustment ${p.cause} repeated with different content`); } s.adjustments[ikey] = icontent; if (p.positionId) { const pos = positionOf(s, p.positionId); const next = M.add(ownedBase(pos), p.delta); if (M.isNegative(next)) refuse('INVENTORY_NEGATIVE', 'adjustment would make owned base negative'); pos.confirmedBase = M.add(pos.confirmedBase, p.delta); pos.adjustments = [...(pos.adjustments ?? []), { ...p }]; } else pushBounded(s.externalActivity, { kind: 'UNKNOWN', ref: p.cause, asset: p.asset, amount: p.delta, receiptTs: p.ts, adjustment: true }, MAX_EXTERNAL); },
  DUST_STATE(s, p) { const pos = positionOf(s, p.positionId); if (!M.eq(ownedBase(pos), p.base)) refuse('DUST_MISMATCH', `${ownedBase(pos)} != ${p.base}`); if (p.state === 'WRITTEN_OFF' && !p.ownerRef) refuse('OWNER_WRITEOFF_REQUIRED', 'a write-off is an owner-approved accounting adjustment'); pos.dust = { base: p.base, state: p.state, ownerRef: p.ownerRef, ts: p.ts }; pos.state = p.state === 'WRITTEN_OFF' ? 'FLAT' : 'DUST_UNRESOLVED'; if (p.state === 'WRITTEN_OFF') { pos.writtenOffBase = p.base; pos.baseFees = M.add(pos.baseFees, p.base); pos.riskReserved = '0'; pos.feedPinned = false; recomputeRealized(s, pos); } },
  CLOCK_ANCHOR(s, p) { const prev = s.clockAnchor; if (prev && p.watermarkTs < prev.watermarkTs) refuse('WATERMARK_BACKWARDS', 'the durable watermark never moves backwards'); s.clockAnchor = { ...p }; if (!p.trusted) s.restrictions.CLOCK_UNTRUSTED = s.restrictions.CLOCK_UNTRUSTED ?? { ts: p.watermarkTs, source: 'clock', reason: p.source }; else delete s.restrictions.CLOCK_UNTRUSTED; },
  FEED_PIN(s, p) { if (p.action === 'PIN') s.pins[p.symbol] = { reason: p.reason, ts: p.ts }; else { const held = heldPositions(s).some((x) => x.pair === p.symbol && x.state !== 'FLAT'); if (held) refuse('PIN_HELD', 'a held / pending symbol cannot release its pin'); delete s.pins[p.symbol]; } for (const pos of Object.values(s.positions)) if (pos.pair === p.symbol) pos.feedPinned = p.action === 'PIN'; },
};
function settleEntryTerminal(s, o) { if (o.kind !== 'ENTRY' && o.kind !== 'CANARY_ENTRY') return; const pos = s.positions[o.positionId]; if (!pos) return; pos.pendingEntryBase = '0'; if (M.isZero(pos.confirmedBase) && pos.state === 'PENDING_ENTRY') pos.state = 'SHELL'; }
// exact basis allocation (closeout R06): the entry cost (quote + quote fees) is the cost of the NET acquired inventory
// (confirmed base minus base fees minus write-offs); a disposal carries its pro-rata share, a fully disposed or FLAT
// position carries the whole cost (no rounding residue); a residual write-off is a disposal without proceeds
function recomputeRealized(s, pos) { if (pos.pnlUnknown) { pos.realizedPnl = null; return; } const disposed = M.add(pos.soldBase, pos.writtenOffBase ?? '0'); if (!M.isZero(disposed) || pos.state === 'FLAT') { const net = M.sub(pos.confirmedBase, M.sub(pos.baseFees, pos.writtenOffBase ?? '0')); const cost = M.add(pos.entryQuote, pos.entryFeesQuote); const entryAllocated = M.isZero(net) ? '0' : (pos.state === 'FLAT' || !M.lt(disposed, net)) ? cost : M.div(M.mul(cost, disposed), net, 8, 'HALF_UP'); pos.realizedPnl = M.sub(M.sub(pos.exitQuote, pos.exitFeesQuote), entryAllocated); } s.realized.pnl = M.sum(Object.values(s.positions).map((x) => x.realizedPnl ?? '0')); }

// which child does a PROTECTION_STATE name? the journal order id when known, else the native id of an already-booked child, else the native id itself (an unbooked confirmed child), else none (an unbound PENDING template)
function childKey(prot, p) { const children = prot.children ?? {}; if (p.orderId && children[p.orderId]) return p.orderId; if (p.nativeOrderId) { const k = Object.keys(children).find((x) => children[x].nativeOrderId === p.nativeOrderId); if (k) return k; if (p.orderId) return p.orderId; return p.nativeOrderId; } if (p.orderId) return p.orderId; return null; }
const CHILD_LIVE = new Set(['ACTIVE', 'AMEND_PENDING']); const CHILD_OPEN = new Set(['PENDING', 'ACTIVE', 'AMEND_PENDING', 'CANCEL_PENDING', 'TRIGGERED', 'MISMATCH']);
// the aggregate of the set: exact coverage law over OWNED base (a triggered child's unfilled remainder still counts while it fires)
function deriveProtection(s, pos, prot, ts) {
  const children = prot.children ?? {}; const list = Object.values(children); const owned = ownedBase(pos);
  const covering = list.filter((c) => CHILD_LIVE.has(c.state) || c.state === 'CANCEL_PENDING' || c.state === 'TRIGGERED'); const coverage = M.sum(covering.map((c) => M.sub(c.qty ?? '0', c.filledBase ?? '0')));
  const primary = list.find((c) => CHILD_LIVE.has(c.state)) ?? list.find((c) => c.state === 'TRIGGERED') ?? list.find((c) => CHILD_OPEN.has(c.state)) ?? list[list.length - 1] ?? null;
  let state; let mismatch = null;
  if (list.some((c) => c.state === 'MISMATCH')) state = 'MISMATCH'; else if (list.some((c) => c.state === 'FAILED') && !list.some((c) => CHILD_LIVE.has(c.state) || c.state === 'PENDING')) state = 'FAILED';
  else if (list.some((c) => c.state === 'TRIGGERED')) state = 'TRIGGERED'; else if (list.some((c) => c.state === 'CANCEL_PENDING')) state = 'CANCEL_PENDING';
  else if (!M.isZero(owned) && covering.length && M.gt(coverage, owned)) { state = 'MISMATCH'; mismatch = `children cover ${coverage} above owned ${owned} (over-coverage would oversell)`; }
  else if (list.some((c) => c.state === 'AMEND_PENDING')) state = 'AMEND_PENDING';
  else if (list.some((c) => c.state === 'PENDING') || prot.unbound) state = 'PENDING';
  else if (list.some((c) => c.state === 'ACTIVE')) { if (!M.isZero(owned) && M.lt(coverage, owned)) { state = 'MISMATCH'; mismatch = `covers ${coverage} of ${owned}`; } else state = 'ACTIVE'; }
  else if (list.length && list.every((c) => c.state === 'CANCELLED' || c.state === 'FAILED')) state = list.every((c) => c.state === 'FAILED') ? 'FAILED' : 'CANCELLED';
  else state = prot.state === 'TEMPLATE_READY' || prot.state === 'NONE' ? prot.state : 'NONE';
  if (mismatch) s.restrictions.PROTECTION_MISMATCH = { ts, source: 'reducer', reason: `position ${pos.positionId} protection ${mismatch}` };
  return { ...prot, children, state, coverage, orderId: primary?.orderId ?? null, nativeOrderId: primary?.nativeOrderId ?? null, trigger: primary?.trigger ?? prot.unbound?.trigger ?? prot.trigger ?? null, qty: covering.length ? coverage : primary?.qty ?? prot.unbound?.qty ?? null, confirmedTs: primary?.confirmedTs ?? null, pendingAmend: list.find((c) => c.pendingAmend)?.pendingAmend ?? null, mismatch, reason: primary?.reason ?? null };
}
