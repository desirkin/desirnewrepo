// EXECUTION — the ONE current entry-authority law (closeout R01). The Judge consults it before it commits a reservation
// and the dispatcher consults it again immediately before the actual send, after every queue wait and await, on the
// state the journal holds at that instant. NEW exposure needs every clause; an owned protective reduction needs only
// ownership, a held writer and an open sender (reductionAuthority): KILL / REDUCE_ONLY / an expired authorization stop
// additions, never the flatten of what is already owned. Pure over (state, order, context); no I/O.
import * as M from './money.js';
import { entryBlockingRestrictions, ownedBase, allocationRemaining, availableCash } from './reducer.js';
import { TERMINAL_ORDER_STATES } from './contract.js';

export const AUTHORITY_VERSION = 'execution-authority-1';
const ENTRY_MODES = Object.freeze(['PAPER', 'REPLAY', 'LIVE_ARMED']);
const authorizationActive = (s, ts) => Boolean(s.authorization && !s.authorization.ended && s.authorization.expiresTs > ts);

// the account-level permission intersection shared by the Judge (pre-commit) and the dispatcher (pre-send)
export function entryPermission(state, { controls = null, nowTs, assetId = null, pair = null, runMode = null, clockTrusted = true, writerHeld = true } = {}) {
  const reasons = []; const s = state;
  if (!s || !s.initialized) return { ok: false, reasons: ['ACCOUNT_UNINITIALIZED'] };
  if (writerHeld === false) reasons.push('WRITER_LOST');
  const ctl = controls ?? { kill: false, cage: false, vetoes: [] };
  if (ctl.kill || s.restrictions.KILL) reasons.push('KILL'); if (ctl.cage) reasons.push('CAGE');
  if (assetId && ((ctl.vetoes ?? []).includes(assetId) || s.vetoes.includes(assetId))) reasons.push('VETOED');
  for (const r of entryBlockingRestrictions(s)) if (!reasons.includes(r)) reasons.push(r);
  if (!ENTRY_MODES.includes(s.mode)) reasons.push(`MODE_${s.mode}`);
  if (runMode === 'OBSERVE') reasons.push('OBSERVE_NO_DISPATCH');
  if (s.accountKind === 'LIVE') { if (!authorizationActive(s, nowTs)) reasons.push('ARM_REQUIRED'); else if (s.authorization.kind === 'CANARY' && pair && s.authorization.canary?.pair !== pair) reasons.push('CANARY_PAIR'); if (clockTrusted === false) reasons.push('CLOCK_UNTRUSTED'); }
  if (s.valuation.unknown) reasons.push('VALUATION_UNKNOWN');
  return { ok: reasons.length === 0, reasons };
}
// the last-boundary check for ONE unsent entry intent: every clause the ticket names, on the current state
// spec / fee: pass the looked-up contract (null = unknown -> refused) or the UNCHECKED sentinel when the caller has no lookup at all
export const UNCHECKED = 'UNCHECKED';
export function entryAuthority(state, order, { controls = null, nowTs, runMode = null, clockTrusted = true, writerHeld = true, binding = null, spec = UNCHECKED, fee = UNCHECKED, quote = null, expectedRevision = null, revision = null, phase = 'BEFORE_ATTEMPT' } = {}) {
  const s = state; const reasons = [];
  if (!order) return { ok: false, reasons: ['ORDER_UNKNOWN'] };
  // BEFORE_ATTEMPT: the intent is still UNSENT; BEFORE_SEND: the durable attempt exists (DISPATCH_UNCERTAIN) and is unresolved, nothing has reached the wire
  if (phase === 'BEFORE_SEND') { const att = order.attempts?.[order.attempts.length - 1] ?? null; if (order.state !== 'DISPATCH_UNCERTAIN' || !att || att.outcome !== null || order.attempts.length !== 1 || order.nativeOrderId) reasons.push(`ORDER_${order.state}`); }
  else if (order.state !== 'UNSENT') reasons.push(`ORDER_${order.state}`);
  if (order.kind !== 'ENTRY' && order.kind !== 'CANARY_ENTRY') reasons.push('NOT_AN_ENTRY');
  const perm = entryPermission(s, { controls, nowTs, assetId: s.positions[order.positionId]?.assetId ?? null, pair: order.pair ?? null, runMode, clockTrusted, writerHeld }); reasons.push(...perm.reasons);
  if (expectedRevision !== null && revision !== null && expectedRevision !== revision) reasons.push('REVISION_CHANGED');
  const a = s.authorization; const active = authorizationActive(s, nowTs);
  if (s.accountKind === 'LIVE' && active) {
    if (order.kind === 'ENTRY' && a.kind !== 'LIVE_ARM') reasons.push('AUTHORIZATION_KIND'); if (order.kind === 'CANARY_ENTRY' && a.kind !== 'CANARY') reasons.push('AUTHORIZATION_KIND');
    if (binding) { if (binding.policyDigest && a.policyDigest !== binding.policyDigest) reasons.push('POLICY_BINDING_CHANGED'); if (binding.codeDigest && a.codeDigest && a.codeDigest !== binding.codeDigest) reasons.push('CODE_BINDING_CHANGED'); if (binding.keyFingerprint !== undefined && a.keyFingerprint && a.keyFingerprint !== binding.keyFingerprint) reasons.push('KEY_BINDING_CHANGED'); if (binding.releaseDigest && a.releaseDigest && a.releaseDigest !== binding.releaseDigest) reasons.push('RELEASE_BINDING_CHANGED'); }
  }
  const r = order.reservationId ? s.reservations[order.reservationId] : null;
  if (!r || r.state !== 'OPEN' || r.orderId !== order.orderId) reasons.push('RESERVATION_NOT_COVERING');
  else if (M.gt(M.mul(order.qty, order.limitPrice), r.cashReserved)) reasons.push('RESERVATION_NOT_COVERING');
  const remaining = allocationRemaining(s); if (remaining !== null && r && r.state === 'OPEN' && M.lt(M.add(remaining, r.cashReserved), r.cashReserved)) reasons.push('ALLOCATION_EXCEEDED');
  if (M.lt(availableCash(s), '0')) reasons.push('CASH_OVERDRAWN');
  if (spec !== UNCHECKED) { if (!spec) reasons.push('SPEC_UNKNOWN'); else { if (spec.specDigest !== order.specDigest) reasons.push('SPEC_CHANGED'); if (spec.status !== 'online') reasons.push(`INSTRUMENT_${String(spec.status).toUpperCase()}`); } }
  if (fee !== UNCHECKED) { if (!fee) reasons.push('FEE_UNKNOWN'); else { if (fee.feeDigest !== order.feeDigest) reasons.push('FEE_CHANGED'); if (fee.expiresTs !== null && fee.expiresTs !== undefined && fee.expiresTs <= nowTs) reasons.push('FEE_EXPIRED'); } }
  if (quote) { if (quote.usable === false) reasons.push('QUOTE_NOT_FRESH'); }
  if (order.deadlineTs !== null && order.deadlineTs !== undefined && nowTs >= order.deadlineTs) reasons.push('INTENT_DEADLINE_PASSED');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], authorityVersion: AUTHORITY_VERSION };
}
// an owned protective reduction: sells only what the account owns and has not already committed to another open sell
export function reductionAuthority(state, intent, { writerHeld = true, senderOpen = true } = {}) {
  const reasons = []; const pos = state.positions[intent.positionId];
  if (!pos) return { ok: false, reasons: ['POSITION_UNKNOWN'] };
  if (intent.side !== 'sell') reasons.push('NOT_A_REDUCTION');
  if (writerHeld === false) reasons.push('WRITER_LOST'); if (senderOpen === false) reasons.push('SENDER_CLOSED');
  const openSells = Object.values(state.orders).filter((o) => o.positionId === intent.positionId && o.side === 'sell' && o.orderId !== intent.orderId && !TERMINAL_ORDER_STATES.includes(o.state));
  const locked = M.sum(openSells.map((o) => M.sub(o.qty, o.filledBase))); const available = M.sub(ownedBase(pos), locked);
  if (!M.isPositive(intent.qty) || M.gt(intent.qty, available)) reasons.push('OVERSELL');
  return { ok: reasons.length === 0, reasons, ownedBase: ownedBase(pos), available };
}
