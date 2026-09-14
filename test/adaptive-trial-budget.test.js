import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDigest } from '../learning/contracts.js';
import { trialAlpha } from '../learning/sequential-forecast.js';
import {
  openExternalCheckpointStore, EXTERNAL_CHECKPOINT_IDS,
  EXTERNAL_CHECKPOINT_RECORD_VERSION,
} from '../persistence/external-checkpoint-store.js';
import {
  adaptiveTrialBudgetError, openAdaptiveTrialBudget, ADAPTIVE_TRIAL_BUDGET_VERSION,
  ADAPTIVE_TRIAL_CHECKPOINT_ID, ADAPTIVE_TRIAL_MAX_RECORDS, ADAPTIVE_TRIAL_NAMESPACE,
} from '../learning/adaptive-trial-budget.js';

const H = (value) => canonicalDigest(value);
const FAMILY = Object.freeze({ targetDigest: H('target'), procedureFamilyDigest: H('procedure-family'),
  consumerContractDigest: H('consumer'), recipeDigest: H('recipe'), promotionPolicyDigest: H('promotion') });
const request = (id, family = FAMILY) => ({ requestDigest: H(`request-${id}`), intentDigest: H(`intent-${id}`), family });

// Synthetic database seam; never reads environment, connects or claims PG
// recovery. The real checkpoint owner still enforces lock/validator/CAS logic.
function persistence(rows = new Map()) {
  let lockHeld = false;
  const p = {
    rows, conflict: false, failWrite: false, writes: 0,
    health: () => ({ databaseConfigured: true, restored: true }),
    db: { acquireSessionLock: async () => {
      if (lockHeld) return null;
      lockHeld = true; let owned = true;
      return { held: () => owned && lockHeld, release: async () => { owned = false; lockHeld = false; } };
    } },
    loseLock: () => { lockHeld = false; },
  };
  p.repo = {
    loadRuntimeState: async (id) => rows.has(id) ? structuredClone(rows.get(id)) : null,
    saveRuntimeState: async (id, state, expectedRevision) => {
      if (p.failWrite) throw new Error('SYNTHETIC_WRITE_FAILED');
      const current = rows.get(id);
      if (p.conflict || expectedRevision !== (current?.revision ?? null)) return { conflict: true };
      const next = { revision: (current?.revision ?? 0) + 1, state: structuredClone(state) };
      rows.set(id, next); p.writes += 1; return { ...structuredClone(next), conflict: false };
    },
  };
  return p;
}

async function setup({ rows, commission = true } = {}) {
  const p = persistence(rows); const owner = await openExternalCheckpointStore({ persistence: p });
  let ts = 1_000;
  const budget = await openAdaptiveTrialBudget({ checkpointStore: owner, clock: () => ts,
    commission: commission ? { allowCreate: true, rootAlpha: 0.05, reason: 'synthetic explicit first commission' } : null });
  return { p, owner, budget, clock: (value) => { ts = value; } };
}

const bindingInput = (row, overrides = {}) => ({ allocationId: row.allocationId,
  candidateDigest: H(`candidate-${row.ordinal}`), procedureDigest: H('sealed-procedure'),
  candidateFrozenTs: row.reservedTs, captureNotBeforeTs: row.reservedTs, ...overrides });

function closedCheckpoint(closedTrials, { rootAlpha = 0.05, createdTs = 1_000 } = {}) {
  const state = { version: ADAPTIVE_TRIAL_BUDGET_VERSION, namespace: ADAPTIVE_TRIAL_NAMESPACE,
    allocationLaw: 'GLOBAL_ALPHA_OVER_J_TIMES_J_PLUS_ONE', rootAlpha, createdTs,
    rootDigest: '', records: [], headDigest: '' };
  state.rootDigest = H({ version: state.version, namespace: state.namespace,
    allocationLaw: state.allocationLaw, rootAlpha, createdTs });
  let previous = state.rootDigest;
  const event = (type, body, recordedTs) => {
    const row = { sequence: state.records.length + 1, previousDigest: previous, type, recordedTs, body, eventDigest: '' };
    row.eventDigest = H(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'eventDigest')));
    state.records.push(row); previous = row.eventDigest;
  };
  for (let ordinal = 1; ordinal <= closedTrials; ordinal += 1) {
    const requestDigest = H(`capacity-request-${ordinal}`); const intentDigest = H(`capacity-intent-${ordinal}`);
    const familyId = H({ namespace: ADAPTIVE_TRIAL_NAMESPACE, family: FAMILY });
    const allocationId = H({ rootDigest: state.rootDigest, ordinal, familyId, requestDigest, intentDigest });
    event('RESERVED', { requestDigest, intentDigest, family: FAMILY, familyId, ordinal,
      alpha: trialAlpha({ familyAlpha: rootAlpha, trialOrdinal: ordinal }), allocationId }, createdTs + ordinal * 2 - 1);
    event('BOUND', { allocationId, candidateDigest: H(`capacity-candidate-${ordinal}`),
      procedureDigest: H('sealed-procedure'), candidateFrozenTs: createdTs + ordinal * 2 - 1,
      captureNotBeforeTs: createdTs + ordinal * 2 }, createdTs + ordinal * 2);
  }
  state.headDigest = previous;
  assert.equal(adaptiveTrialBudgetError(state), null);
  return state;
}

test('trial budget requires explicit commissioning; missing history never means unused alpha', async () => {
  const p = persistence(); const owner = await openExternalCheckpointStore({ persistence: p });
  await assert.rejects(openAdaptiveTrialBudget({ checkpointStore: owner }), /CHECKPOINT_ABSENT/);
  assert.equal(p.writes, 0);
  const unrelated = await owner.restore({ id: EXTERNAL_CHECKPOINT_IDS.MARKET, validate: (s) => s.used === 0 ? null : 'invalid',
    commission: { allowCreate: true, reason: 'synthetic market checkpoint', ts: 1, state: { used: 0 } } });
  assert.equal(unrelated.snapshot().used, 0, 'learning absence does not disable authorized collection checkpoint');
  await owner.close();
});

test('global ordinal and summable alpha survive different families, changed recipes and concurrent reservations', async () => {
  const { owner, budget } = await setup();
  const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => budget.reserve(request(i,
    { ...FAMILY, procedureFamilyDigest: H(`family-${i}`), recipeDigest: H(`recipe-${i}`) }))));
  assert.deepEqual(rows.map((r) => r.ordinal), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const row of rows) {
    assert.equal(row.alpha, 0.05 / (row.ordinal * (row.ordinal + 1)));
    assert.equal(row.authority, 'NONE'); assert.equal(row.qualificationVerified, false);
  }
  assert.equal(budget.status().consumedOrdinals, 12);
  assert.ok(rows.reduce((sum, row) => sum + row.alpha, 0) < 0.05);
  assert.equal(budget.status().remainingAlphaUpperBound, 0.05 / 13);
  await owner.close();
});

test('exact request retries consume one ordinal; renamed claims cannot reuse a reservation', async () => {
  const { owner, budget } = await setup();
  const input = request('same');
  const [a, b] = await Promise.all([budget.reserve(input), budget.reserve(input)]);
  assert.equal(a.allocationId, b.allocationId); assert.equal(budget.status().consumedOrdinals, 1);
  assert.equal(budget.status().records, 1, 'idempotent CAS acknowledgement creates no statistical event');
  await assert.rejects(budget.reserve({ ...input, intentDigest: H('different-claim') }), /TRIAL_REQUEST_CONFLICT/);
  await assert.rejects(budget.reserve({ ...input, family: { ...FAMILY, targetDigest: H('other-target') } }), /TRIAL_REQUEST_CONFLICT/);
  await assert.rejects(budget.reserve({ ...input, displayName: 'rename' }), /TRIAL_RESERVE_INPUT_INVALID/);
  const next = await budget.reserve(request('new-name'));
  assert.equal(next.ordinal, 2); assert.equal(next.alpha, 0.05 / 6);
  await owner.close();
});

test('reservation precedes frozen candidate and declared capture; binding is immutable and not qualification', async () => {
  const { owner, budget, clock } = await setup(); const row = await budget.reserve(request(1));
  clock(1_100);
  await assert.rejects(budget.bind(bindingInput(row, { candidateFrozenTs: 999, captureNotBeforeTs: 1_100 })), /TRIAL_BINDING_INVALID/);
  await assert.rejects(budget.bind(bindingInput(row, { candidateFrozenTs: 1_101, captureNotBeforeTs: 1_100 })), /TRIAL_BINDING_INVALID/);
  await assert.rejects(budget.bind(bindingInput(row, { captureNotBeforeTs: 1_099 })), /TRIAL_BINDING_INVALID/);
  const input = bindingInput(row, { candidateFrozenTs: 1_050, captureNotBeforeTs: 1_200 });
  const bound = await budget.bind(input); assert.equal(bound.status, 'BOUND');
  assert.equal(bound.binding.boundTs, 1_100); assert.equal(bound.captureChronologyExternallyVerified, false);
  clock(1_500);
  assert.equal((await budget.bind(input)).allocationId, row.allocationId);
  await assert.rejects(budget.bind({ ...input, candidateDigest: H('renamed-candidate') }), /TRIAL_BIND_CONFLICT/);
  assert.equal(budget.status().records, 2);
  const other = await budget.reserve(request(2));
  await assert.rejects(budget.bind(bindingInput(other, { candidateDigest: input.candidateDigest })), /TRIAL_BINDING_INVALID/);
  await owner.close();
});

test('abandoned and crash-unbound reservations stay spent across normal restart', async () => {
  const a = await setup(); const one = await a.budget.reserve(request(1)); const two = await a.budget.reserve(request(2));
  await a.budget.abandon({ allocationId: one.allocationId, reason: 'DESIGN_ABORTED' });
  await a.budget.abandon({ allocationId: one.allocationId, reason: 'DESIGN_ABORTED' });
  await assert.rejects(a.budget.bind(bindingInput(one)), /TRIAL_BINDING_INVALID/);
  await a.owner.close();
  const b = await setup({ rows: a.p.rows, commission: false });
  assert.equal(b.budget.readAllocation(one.allocationId).status, 'ABANDONED');
  assert.equal(b.budget.readAllocation(two.allocationId).status, 'RESERVED');
  assert.equal(b.budget.status().consumedOrdinals, 2);
  assert.equal((await b.budget.reserve(request(3))).ordinal, 3);
  await b.owner.close();
});

test('recommissioning cannot replenish or silently change the root allowance', async () => {
  const a = await setup(); await a.budget.reserve(request(1)); await a.owner.close();
  const p = persistence(a.p.rows); const owner = await openExternalCheckpointStore({ persistence: p });
  await assert.rejects(openAdaptiveTrialBudget({ checkpointStore: owner, clock: () => 2_000,
    commission: { allowCreate: true, rootAlpha: 0.10, reason: 'not permission to reset' } }), /TRIAL_COMMISSION_CONFLICT/);
  const restored = await openAdaptiveTrialBudget({ checkpointStore: owner, clock: () => 2_000,
    commission: { allowCreate: true, rootAlpha: 0.05, reason: 'existing state must win' } });
  assert.equal(restored.status().consumedOrdinals, 1); assert.equal((await restored.reserve(request(2))).ordinal, 2);
  await owner.close();
});

test('strict replay refuses broken chain, unsupported history, duplicate ordinals, and altered alpha', async () => {
  const { p, owner, budget } = await setup(); await budget.reserve(request(1));
  const source = p.rows.get(ADAPTIVE_TRIAL_CHECKPOINT_ID).state.checkpoint;
  assert.equal(adaptiveTrialBudgetError(source), null);
  for (const mutate of [
    (s) => { s.records[0].body.alpha = 0.5; },
    (s) => { s.records[0].body.ordinal = 2; },
    (s) => { s.version = 'old-questions-history'; },
    (s) => { s.records = []; },
    (s) => { s.records[0].previousDigest = H('other-head'); },
  ]) {
    const changed = structuredClone(source); mutate(changed); assert.notEqual(adaptiveTrialBudgetError(changed), null);
  }
  const badRows = structuredClone(p.rows); badRows.get(ADAPTIVE_TRIAL_CHECKPOINT_ID).state.checkpoint.records[0].body.alpha = 0.9;
  await owner.close();
  const badP = persistence(badRows); const badOwner = await openExternalCheckpointStore({ persistence: badP });
  await assert.rejects(openAdaptiveTrialBudget({ checkpointStore: badOwner }), /CHECKPOINT_INVALID/);
  assert.equal(badP.writes, 0, 'corrupt history is never silently repaired'); await badOwner.close();
});

test('CAS conflict, failed acknowledgement and lost lock refuse subsequent allocations', async () => {
  for (const failure of ['conflict', 'failWrite', 'loseLock']) {
    const { owner, budget, p } = await setup();
    if (failure === 'loseLock') p.loseLock(); else p[failure] = true;
    await assert.rejects(budget.reserve(request(1)));
    await assert.rejects(budget.reserve(request(2)));
    await assert.rejects(budget.bind(bindingInput({ allocationId: H('absent'), ordinal: 1, reservedTs: 1_000 })));
    await owner.close();
  }
});

test('regressing clock cannot create evidence or bind a later candidate backwards', async () => {
  const { owner, budget, clock } = await setup(); const one = await budget.reserve(request(1));
  clock(999); await assert.rejects(budget.reserve(request(2)), /TRIAL_EVENT_CHAIN_INVALID/);
  await assert.rejects(budget.bind(bindingInput(one)), /TRIAL_EVENT_CHAIN_INVALID/);
  assert.equal(budget.status().consumedOrdinals, 1); await owner.close();
});

test('one external-checkpoint owner and one fixed checkpoint key survive restart', async () => {
  const p = persistence();
  const owner = await openExternalCheckpointStore({ persistence: p });
  await assert.rejects(openExternalCheckpointStore({ persistence: p }), /LOCK_HELD_ELSEWHERE/);
  const budget = await openAdaptiveTrialBudget({ checkpointStore: owner, clock: () => 1_000,
    commission: { allowCreate: true, rootAlpha: 0.05, reason: 'synthetic fixed-key commission' } });
  const allocated = await budget.reserve(request('fixed-key'));
  assert.equal(ADAPTIVE_TRIAL_CHECKPOINT_ID, 'external_quota:adaptive-statistics:v1');
  assert.deepEqual([...p.rows.keys()], [ADAPTIVE_TRIAL_CHECKPOINT_ID]);
  assert.ok(!Object.values(EXTERNAL_CHECKPOINT_IDS).includes(ADAPTIVE_TRIAL_CHECKPOINT_ID));
  await owner.close();

  const restoredOwner = await openExternalCheckpointStore({ persistence: p });
  const restored = await openAdaptiveTrialBudget({ checkpointStore: restoredOwner, clock: () => 2_000 });
  assert.equal(restored.readAllocation(allocated.allocationId).allocationId, allocated.allocationId);
  assert.equal(restored.status().consumedOrdinals, 1);
  await restoredOwner.close();
});

test('reserve, bind and abandon freeze caller inputs before queued durable mutation', async () => {
  const { owner, budget } = await setup();
  const reserveInput = request('copy-at-entry', { ...FAMILY });
  const reserveOriginal = structuredClone(reserveInput);
  const reservePromise = budget.reserve(reserveInput);
  reserveInput.intentDigest = H('mutated-intent');
  reserveInput.family.targetDigest = H('mutated-family');
  const reserved = await reservePromise;
  assert.equal(reserved.intentDigest, reserveOriginal.intentDigest);
  assert.deepEqual(reserved.family, reserveOriginal.family);

  const bindInput = bindingInput(reserved);
  const bindOriginal = structuredClone(bindInput);
  const bindPromise = budget.bind(bindInput);
  bindInput.candidateDigest = H('mutated-candidate');
  bindInput.captureNotBeforeTs += 1;
  const bound = await bindPromise;
  assert.deepEqual(Object.fromEntries(Object.keys(bindOriginal).map((key) => [key, bound.binding[key]])), bindOriginal);

  const abandonedReservation = await budget.reserve(request('copy-abandon'));
  const abandonInput = { allocationId: abandonedReservation.allocationId, reason: 'DESIGN_ABORTED' };
  const abandonPromise = budget.abandon(abandonInput);
  abandonInput.reason = 'MUTATED_REASON';
  const abandoned = await abandonPromise;
  assert.equal(abandoned.abandonment.reason, 'DESIGN_ABORTED');
  await owner.close();
});

test('reservation capacity always retains one immutable closure slot and remains exhausted after restart', async () => {
  const rootAlpha = 0.05; const createdTs = 1_000;
  const checkpoint = closedCheckpoint(ADAPTIVE_TRIAL_MAX_RECORDS / 2 - 1, { rootAlpha, createdTs });
  const rows = new Map([[ADAPTIVE_TRIAL_CHECKPOINT_ID, { revision: 1, state: {
    v: EXTERNAL_CHECKPOINT_RECORD_VERSION, id: ADAPTIVE_TRIAL_CHECKPOINT_ID, checkpoint,
    commissioning: { mode: 'EXPLICIT_COMMISSION', reason: 'synthetic near-capacity history', ts: createdTs },
  } }]]);
  const p = persistence(rows); const owner = await openExternalCheckpointStore({ persistence: p });
  let ts = createdTs + ADAPTIVE_TRIAL_MAX_RECORDS + 1;
  const budget = await openAdaptiveTrialBudget({ checkpointStore: owner, clock: () => ts });
  assert.equal(budget.status().records, ADAPTIVE_TRIAL_MAX_RECORDS - 2);
  assert.equal(budget.status().unresolvedReservations, 0);
  assert.equal(budget.status().remainingReservableTrials, 1);

  const final = await budget.reserve(request('last-reservable'));
  assert.equal(budget.status().records, ADAPTIVE_TRIAL_MAX_RECORDS - 1);
  assert.equal(budget.status().unresolvedReservations, 1);
  assert.equal(budget.status().remainingReservableTrials, 0);
  assert.equal(budget.status().reservationCapacityExhausted, true);
  await assert.rejects(budget.reserve(request('must-not-strand')), /TRIAL_RESERVATION_CAPACITY_EXHAUSTED/);
  assert.equal(budget.status().records, ADAPTIVE_TRIAL_MAX_RECORDS - 1);

  ts += 1;
  await budget.bind(bindingInput(final, { candidateFrozenTs: final.reservedTs, captureNotBeforeTs: ts }));
  assert.equal(budget.status().records, ADAPTIVE_TRIAL_MAX_RECORDS);
  assert.equal(budget.status().unresolvedReservations, 0);
  await owner.close();

  const restoredOwner = await openExternalCheckpointStore({ persistence: p });
  const restored = await openAdaptiveTrialBudget({ checkpointStore: restoredOwner, clock: () => ts + 1 });
  assert.equal(restored.readAllocation(final.allocationId).status, 'BOUND');
  assert.equal(restored.status().records, ADAPTIVE_TRIAL_MAX_RECORDS);
  assert.equal(restored.status().reservationCapacityExhausted, true);
  await assert.rejects(restored.reserve(request('after-restart')), /TRIAL_RESERVATION_CAPACITY_EXHAUSTED/);
  await restoredOwner.close();
});
