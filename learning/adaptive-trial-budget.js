// One durable statistical budget, injected into the existing checkpoint owner.
// No database connection, new lock owner, local journal, promoter or runtime
// wiring lives here. A reservation is not evidence or permission to activate.
import { canonicalDigest, deepFreeze, exactKeys, isTs } from './contracts.js';
import { trialAlpha } from './sequential-forecast.js';

export const ADAPTIVE_TRIAL_BUDGET_VERSION = 'adaptive-trial-budget-1';
export const ADAPTIVE_TRIAL_CHECKPOINT_ID = 'external_quota:adaptive-statistics:v1';
export const ADAPTIVE_TRIAL_NAMESPACE = 'serpent-adaptive-statistics-1';
export const ADAPTIVE_TRIAL_MAX_RECORDS = 10_000;
const LAW = 'GLOBAL_ALPHA_OVER_J_TIMES_J_PLUS_ONE';
const HEX = /^[a-f0-9]{64}$/;
const FAMILY_KEYS = ['targetDigest', 'procedureFamilyDigest', 'consumerContractDigest', 'recipeDigest', 'promotionPolicyDigest'];
const ROOT_KEYS = ['version', 'namespace', 'allocationLaw', 'rootAlpha', 'createdTs', 'rootDigest', 'records', 'headDigest'];
const EVENT_KEYS = ['sequence', 'previousDigest', 'type', 'recordedTs', 'body', 'eventDigest'];
const RESERVE_KEYS = ['requestDigest', 'intentDigest', 'family', 'familyId', 'ordinal', 'alpha', 'allocationId'];
const BIND_KEYS = ['allocationId', 'candidateDigest', 'procedureDigest', 'candidateFrozenTs', 'captureNotBeforeTs'];
const ABANDON_KEYS = ['allocationId', 'reason'];
const clone = (value) => structuredClone(value);
const digestWithout = (value, key) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)));
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const requireKeys = (value, keys, code) => { if (exactKeys(value, keys)) fail(code); };
const isDigest = (value) => typeof value === 'string' && HEX.test(value);

function familyIdOf(family) {
  requireKeys(family, FAMILY_KEYS, 'TRIAL_FAMILY_INVALID');
  if (FAMILY_KEYS.some((key) => !isDigest(family[key]))) fail('TRIAL_FAMILY_INVALID');
  // Display name, account, creation time, and variant label are not identities.
  return canonicalDigest({ namespace: ADAPTIVE_TRIAL_NAMESPACE, family });
}

function rootDigestOf(state) {
  return canonicalDigest(Object.fromEntries(ROOT_KEYS.filter((key) => !['rootDigest', 'records', 'headDigest'].includes(key)).map((key) => [key, state[key]])));
}

function allocationIdOf(rootDigest, body) {
  return canonicalDigest({ rootDigest, ordinal: body.ordinal, familyId: body.familyId, requestDigest: body.requestDigest, intentDigest: body.intentDigest });
}

function replay(state) {
  requireKeys(state, ROOT_KEYS, 'TRIAL_CHECKPOINT_SCHEMA');
  if (state.version !== ADAPTIVE_TRIAL_BUDGET_VERSION || state.namespace !== ADAPTIVE_TRIAL_NAMESPACE
      || state.allocationLaw !== LAW || !isTs(state.createdTs)
      || !Array.isArray(state.records) || state.records.length > ADAPTIVE_TRIAL_MAX_RECORDS
      || !isDigest(state.rootDigest) || state.rootDigest !== rootDigestOf(state)) fail('TRIAL_CHECKPOINT_INVALID');
  trialAlpha({ familyAlpha: state.rootAlpha, trialOrdinal: 1 });
  const allocations = new Map(); const requests = new Map(); const candidates = new Set();
  let previous = state.rootDigest; let priorTs = state.createdTs; let ordinal = 0; let unresolved = 0;
  for (const [index, event] of state.records.entries()) {
    requireKeys(event, EVENT_KEYS, 'TRIAL_EVENT_SCHEMA');
    if (event.sequence !== index + 1 || event.previousDigest !== previous || !isTs(event.recordedTs)
        || event.recordedTs < priorTs || !isDigest(event.eventDigest)
        || event.eventDigest !== digestWithout(event, 'eventDigest')) fail('TRIAL_EVENT_CHAIN_INVALID');
    const b = event.body;
    if (event.type === 'RESERVED') {
      requireKeys(b, RESERVE_KEYS, 'TRIAL_RESERVATION_SCHEMA');
      if (!isDigest(b.requestDigest) || !isDigest(b.intentDigest) || b.familyId !== familyIdOf(b.family)
          || b.ordinal !== ++ordinal || b.alpha !== trialAlpha({ familyAlpha: state.rootAlpha, trialOrdinal: ordinal })
          || b.allocationId !== allocationIdOf(state.rootDigest, b)
          || requests.has(b.requestDigest) || allocations.has(b.allocationId)) fail('TRIAL_RESERVATION_INVALID');
      const row = { ...clone(b), reservedTs: event.recordedTs, status: 'RESERVED', binding: null, abandonment: null };
      allocations.set(b.allocationId, row); requests.set(b.requestDigest, row);
      unresolved += 1;
    } else if (event.type === 'BOUND') {
      requireKeys(b, BIND_KEYS, 'TRIAL_BINDING_SCHEMA');
      const row = allocations.get(b.allocationId);
      if (!row || row.status !== 'RESERVED' || !isDigest(b.candidateDigest) || !isDigest(b.procedureDigest)
          || candidates.has(b.candidateDigest) || !isTs(b.candidateFrozenTs) || b.candidateFrozenTs < row.reservedTs
          || b.candidateFrozenTs > event.recordedTs || !isTs(b.captureNotBeforeTs)
          || b.captureNotBeforeTs < event.recordedTs) fail('TRIAL_BINDING_INVALID');
      row.status = 'BOUND'; row.binding = { ...clone(b), boundTs: event.recordedTs };
      candidates.add(b.candidateDigest);
      unresolved -= 1;
    } else if (event.type === 'ABANDONED') {
      requireKeys(b, ABANDON_KEYS, 'TRIAL_ABANDON_SCHEMA');
      const row = allocations.get(b.allocationId);
      if (!row || row.status !== 'RESERVED' || typeof b.reason !== 'string'
          || !/^[A-Z][A-Z0-9_]{0,79}$/.test(b.reason)) fail('TRIAL_ABANDON_INVALID');
      row.status = 'ABANDONED'; row.abandonment = { reason: b.reason, abandonedTs: event.recordedTs };
      unresolved -= 1;
    } else fail('TRIAL_EVENT_TYPE_INVALID');
    // Every accepted reservation owns one future bind-or-abandon slot. This
    // invariant prevents a valid checkpoint from reaching the record ceiling
    // with allocations that can never be closed.
    if (index + 1 + unresolved > ADAPTIVE_TRIAL_MAX_RECORDS) fail('TRIAL_CAPACITY_INVARIANT_INVALID');
    previous = event.eventDigest; priorTs = event.recordedTs;
  }
  if (state.headDigest !== previous) fail('TRIAL_HEAD_INVALID');
  return { allocations, requests, candidates, ordinal, priorTs, unresolved };
}

export function adaptiveTrialBudgetError(state) {
  try { replay(state); return null; } catch (error) { return error.code ?? 'TRIAL_CHECKPOINT_INVALID'; }
}

function initialState({ rootAlpha, createdTs }) {
  const state = { version: ADAPTIVE_TRIAL_BUDGET_VERSION, namespace: ADAPTIVE_TRIAL_NAMESPACE,
    allocationLaw: LAW, rootAlpha, createdTs, rootDigest: '', records: [], headDigest: '' };
  state.rootDigest = rootDigestOf(state); state.headDigest = state.rootDigest; replay(state);
  return state;
}

function append(state, type, body, recordedTs) {
  if (state.records.length >= ADAPTIVE_TRIAL_MAX_RECORDS) fail('TRIAL_HISTORY_CAPACITY_EXHAUSTED');
  const event = { sequence: state.records.length + 1, previousDigest: state.headDigest, type, recordedTs, body: clone(body), eventDigest: '' };
  event.eventDigest = digestWithout(event, 'eventDigest');
  const next = { ...state, records: [...state.records, event], headDigest: event.eventDigest };
  replay(next); return next;
}

export async function openAdaptiveTrialBudget({ checkpointStore, commission = null, clock = Date.now } = {}) {
  if (!checkpointStore || typeof checkpointStore.restore !== 'function' || typeof checkpointStore.status !== 'function'
      || typeof checkpointStore.failed !== 'function' || typeof clock !== 'function') fail('TRIAL_CHECKPOINT_OWNER_REQUIRED');
  const now = () => { const ts = clock(); if (!isTs(ts)) fail('TRIAL_CLOCK_INVALID'); return ts; };
  let commissioning = null;
  if (commission !== null) {
    requireKeys(commission, ['allowCreate', 'rootAlpha', 'reason'], 'TRIAL_COMMISSION_INVALID');
    if (commission.allowCreate !== true || typeof commission.reason !== 'string'
        || !commission.reason.trim() || commission.reason.length > 180) fail('TRIAL_COMMISSION_INVALID');
    const ts = now();
    commissioning = { allowCreate: true, reason: commission.reason, ts, state: initialState({ rootAlpha: commission.rootAlpha, createdTs: ts }) };
  }
  // Fixed global checkpoint: new families, names, dates, and recipe revisions
  // consume the SAME ordinal sequence rather than commissioning fresh alpha.
  const binding = await checkpointStore.restore({ id: ADAPTIVE_TRIAL_CHECKPOINT_ID, validate: adaptiveTrialBudgetError, commission: commissioning });
  const restored = binding.snapshot(); replay(restored);
  if (commission && restored.rootAlpha !== commission.rootAlpha) fail('TRIAL_COMMISSION_CONFLICT');

  function ready() {
    const status = checkpointStore.status();
    if (status.closed || status.closing || !status.lockHeld || checkpointStore.failed(ADAPTIVE_TRIAL_CHECKPOINT_ID)) fail('TRIAL_BUDGET_UNAVAILABLE');
  }

  function readAllocation(allocationId) {
    ready(); const state = binding.snapshot(); const row = replay(state).allocations.get(allocationId);
    if (!row) return null;
    return deepFreeze({ ...clone(row), namespace: state.namespace, rootDigest: state.rootDigest,
      custody: { checkpointId: ADAPTIVE_TRIAL_CHECKPOINT_ID, checkpointRevision: binding.revision(), headDigest: state.headDigest,
        recordCount: state.records.length, wholeDatabaseRollbackProtected: false },
      authority: 'NONE', qualificationVerified: false, captureChronologyExternallyVerified: false });
  }

  async function reserve(input) {
    requireKeys(input, ['requestDigest', 'intentDigest', 'family'], 'TRIAL_RESERVE_INPUT_INVALID');
    if (!isDigest(input.requestDigest) || !isDigest(input.intentDigest)) fail('TRIAL_RESERVE_INPUT_INVALID');
    familyIdOf(input.family); const accepted = clone(input); ready(); let allocationId;
    await binding.update((state) => {
      const index = replay(state); const existing = index.requests.get(accepted.requestDigest);
      if (existing) {
        if (existing.intentDigest !== accepted.intentDigest || !same(existing.family, accepted.family)) fail('TRIAL_REQUEST_CONFLICT');
        allocationId = existing.allocationId; return state;
      }
      // A reservation consumes one record now and must retain one record for
      // its eventual immutable BOUND or ABANDONED disposition. Outstanding
      // reservations already own their closure slots.
      if (state.records.length + index.unresolved + 2 > ADAPTIVE_TRIAL_MAX_RECORDS) fail('TRIAL_RESERVATION_CAPACITY_EXHAUSTED');
      const body = { ...accepted, familyId: familyIdOf(accepted.family), ordinal: index.ordinal + 1,
        alpha: trialAlpha({ familyAlpha: state.rootAlpha, trialOrdinal: index.ordinal + 1 }), allocationId: '' };
      body.allocationId = allocationIdOf(state.rootDigest, body); allocationId = body.allocationId;
      return append(state, 'RESERVED', body, now());
    });
    return readAllocation(allocationId);
  }

  async function bind(input) {
    requireKeys(input, BIND_KEYS, 'TRIAL_BIND_INPUT_INVALID'); const accepted = clone(input); ready();
    await binding.update((state) => {
      const row = replay(state).allocations.get(accepted.allocationId);
      if (!row) fail('TRIAL_ALLOCATION_ABSENT');
      if (row.status === 'BOUND') {
        const original = Object.fromEntries(BIND_KEYS.map((key) => [key, row.binding[key]]));
        if (!same(original, accepted)) fail('TRIAL_BIND_CONFLICT'); return state;
      }
      return append(state, 'BOUND', accepted, now());
    });
    return readAllocation(accepted.allocationId);
  }

  async function abandon(input) {
    requireKeys(input, ABANDON_KEYS, 'TRIAL_ABANDON_INPUT_INVALID'); const accepted = clone(input); ready();
    await binding.update((state) => {
      const row = replay(state).allocations.get(accepted.allocationId);
      if (!row) fail('TRIAL_ALLOCATION_ABSENT');
      if (row.status === 'ABANDONED') {
        if (row.abandonment.reason !== accepted.reason) fail('TRIAL_ABANDON_CONFLICT'); return state;
      }
      return append(state, 'ABANDONED', accepted, now());
    });
    return readAllocation(accepted.allocationId);
  }

  function status() {
    ready(); const state = binding.snapshot(); const index = replay(state);
    return deepFreeze({ version: ADAPTIVE_TRIAL_BUDGET_VERSION, namespace: state.namespace,
      rootAlpha: state.rootAlpha, consumedOrdinals: index.ordinal,
      // Telescoping bound, not a rounded sum that could manufacture allowance.
      allocatedAlpha: state.rootAlpha * index.ordinal / (index.ordinal + 1),
      remainingAlphaUpperBound: state.rootAlpha / (index.ordinal + 1),
      checkpointRevision: binding.revision(), headDigest: state.headDigest,
      records: state.records.length, recordCapacity: ADAPTIVE_TRIAL_MAX_RECORDS,
      unresolvedReservations: index.unresolved,
      remainingReservableTrials: Math.floor((ADAPTIVE_TRIAL_MAX_RECORDS - state.records.length - index.unresolved) / 2),
      reservationCapacityExhausted: state.records.length + index.unresolved + 2 > ADAPTIVE_TRIAL_MAX_RECORDS,
      authority: 'NONE', promotionWired: false, wholeDatabaseRollbackProtected: false });
  }
  return Object.freeze({ reserve, bind, abandon, readAllocation, status });
}
