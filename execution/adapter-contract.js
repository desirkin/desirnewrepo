// EXECUTION — the normalized adapter contract (ticket §7.1): ONE lifecycle behind an injected transport / clock / venue
// interface, shared by the PAPER adapter and the real Kraken adapter. Shared commands: preflight, reconcile,
// submitEntryWithProtection, amendProtection, cancelOwnedOrder, closeResidual, stopAdmission, drain. Adapters emit typed
// events shaped EXACTLY like the journal payloads (validated with the same EVENT_SCHEMAS) so the dispatcher never invents
// a fill, an acknowledgement or a flat account; a PAPER adapter can never produce a LIVE success.
import { EVENT_SCHEMAS, shapeError, ContractError, T } from './contract.js';

export const ADAPTER_COMMANDS = Object.freeze(['preflight', 'reconcile', 'submitEntryWithProtection', 'amendProtection', 'cancelOwnedOrder', 'closeResidual', 'stopAdmission', 'drain']);
export const ADAPTER_KINDS = Object.freeze(['PAPER', 'KRAKEN']);
export const ADAPTER_EVENT_TYPES = Object.freeze(['DISPATCH_RESULT', 'EXECUTION_RECORDED', 'ORDER_STATE', 'CANCEL_RESULT', 'PROTECTION_STATE', 'PROTECTION_AMEND', 'RECONCILIATION', 'EXTERNAL_ACTIVITY', 'FEE_ADJUSTMENT']);
// an adapter event: { type (journal event type), payload (journal payload shape), adapter, receiptTs }
export function adapterEventError(ev, where = 'adapterEvent') {
  const e = shapeError(ev, { adapterEventVersion: T.en(['execution-adapter-event-1']), adapter: T.en(ADAPTER_KINDS), type: T.en(ADAPTER_EVENT_TYPES), receiptTs: T.ts, payload: () => null }, where); if (e) return e;
  return shapeError(ev.payload, EVENT_SCHEMAS[ev.type], `${where}.payload(${ev.type})`);
}
export function adapterEvent(adapter, type, payload, receiptTs) { const ev = { adapterEventVersion: 'execution-adapter-event-1', adapter, type, receiptTs, payload }; const e = adapterEventError(ev); if (e) throw new ContractError(e); return Object.freeze(ev); }
// the entry request an adapter receives: the durable ORDER_INTENT payload plus the frozen instrument / fee facts
export const ENTRY_REQUEST_SCHEMA = Object.freeze({ intent: () => null, spec: () => null, fee: () => null, snapshotDigest: T.hex64OrNull, deadlineTs: T.tsOrNull });
export function assertAdapterInterface(a) { for (const c of ADAPTER_COMMANDS) if (typeof a?.[c] !== 'function') throw new ContractError(`adapter lacks ${c}`); if (typeof a.subscribe !== 'function' || !ADAPTER_KINDS.includes(a.kind)) throw new ContractError('adapter lacks subscribe / kind'); return a; }
