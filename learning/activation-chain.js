// LEARN-1 — pure replay law for the append-only activation journal.
//
// An activation is published once, in PUBLISHED_WAITING_FOR_PAPER, then may
// move only through the closed paper-assessment lifecycle below.  Replaying
// history never repairs, reorders, or skips a bad row: a malformed origin,
// gap, immutable-field mutation, clock regression, or illegal edge withholds
// that activation from decision memory while retaining every stored byte.
import { activationError, canonicalDigest } from './contracts.js';

export const ACTIVATION_TRANSITIONS = Object.freeze({
  PUBLISHED_WAITING_FOR_PAPER: Object.freeze(['ACTIVE_PAPER', 'SUSPENDED', 'EXPIRED']),
  ACTIVE_PAPER: Object.freeze(['SUSPENDED', 'ROLLED_BACK', 'EXPIRED']),
  SUSPENDED: Object.freeze(['ACTIVE_PAPER', 'ROLLED_BACK', 'EXPIRED']),
  ROLLED_BACK: Object.freeze([]),
  EXPIRED: Object.freeze([]),
});

export const ACTIVATION_MUTABLE_FIELDS = Object.freeze([
  'seq', 'state', 'transitionReason', 'ts', 'cooldownUntilTs',
]);
const MUTABLE = new Set(ACTIVATION_MUTABLE_FIELDS);
const MAX_REPLAY_ERRORS = 1_000;

export function activationImmutableDigest(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return canonicalDigest(Object.fromEntries(Object.entries(record).filter(([key]) => !MUTABLE.has(key))));
}

export function activationTransitionError(previous, next) {
  const currentErr = activationError(next);
  if (currentErr) return currentErr;
  if (previous === null) {
    if (next.seq !== 0) return 'activation origin must have seq 0';
    if (next.state !== 'PUBLISHED_WAITING_FOR_PAPER') return 'activation origin must be PUBLISHED_WAITING_FOR_PAPER';
    return null;
  }
  const previousErr = activationError(previous);
  if (previousErr) return `previous activation invalid (${previousErr})`;
  if (next.activationId !== previous.activationId) return 'activation identity changed';
  if (next.seq !== previous.seq + 1) return `activation sequence is not contiguous (${previous.seq} -> ${next.seq})`;
  if (next.ts < previous.ts) return 'activation clock regressed';
  if (activationImmutableDigest(next) !== activationImmutableDigest(previous)) return 'activation immutable binding changed';
  if (!(ACTIVATION_TRANSITIONS[previous.state] ?? []).includes(next.state)) return `activation transition ${previous.state} -> ${next.state} is not lawful`;
  return null;
}

export function replayActivationHistory(records) {
  if (!Array.isArray(records)) return { heads: new Map(), invalid: new Map(), globalErrors: ['activation history is not an array'] };
  const heads = new Map();
  const invalid = new Map();
  const globalErrors = [];
  const report = (activationId, reason, index) => {
    const detail = `record ${index + 1}: ${reason}`;
    if (activationId === null) {
      if (globalErrors.length < MAX_REPLAY_ERRORS) globalErrors.push(detail);
      return;
    }
    if (!invalid.has(activationId)) invalid.set(activationId, detail);
    heads.delete(activationId);
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const activationId = record && typeof record === 'object' && !Array.isArray(record)
      && typeof record.activationId === 'string' && record.activationId.length > 0 ? record.activationId : null;
    if (activationId !== null && invalid.has(activationId)) continue;
    const err = activationTransitionError(activationId === null ? null : (heads.get(activationId) ?? null), record);
    if (err) { report(activationId, err, index); continue; }
    heads.set(activationId, record);
  }

  // An unidentifiable malformed row could belong to any activation.  Failing
  // closed globally is the only replay result that does not guess around it.
  if (globalErrors.length > 0) {
    for (const activationId of heads.keys()) if (!invalid.has(activationId)) invalid.set(activationId, globalErrors[0]);
    heads.clear();
  }
  return { heads, invalid, globalErrors };
}
