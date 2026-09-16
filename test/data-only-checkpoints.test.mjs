import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDataOnlyCheckpoints } from '../tools/data-only-checkpoints.mjs';
import { openExternalCheckpointStore, EXTERNAL_CHECKPOINT_IDS } from '../persistence/external-checkpoint-store.js';
import { MARKET_QUOTA_CHECKPOINT_VERSION } from '../market-lab/external-quota-journal.js';
import { QUOTA_JOURNAL_VERSION } from '../market-lab/quota.js';

// PUBLISH-FIX-3 birth commissioning, end to end against the REAL external checkpoint store with an in-memory repo.
class BirthFakeDb { constructor() { this.alive = true; } async acquireSessionLock() { return { held: () => this.alive, release: async () => { this.alive = false; } }; } }
class BirthFakeRepo {
  constructor() { this.rows = new Map(); }
  async loadRuntimeState(id) { const r = this.rows.get(id); return r ? structuredClone(r) : null; }
  async saveRuntimeState(id, state) { const row = { revision: 1, state: structuredClone(state) }; this.rows.set(id, row); return { ...structuredClone(row), conflict: false }; }
}
const birthPersistence = () => ({ db: new BirthFakeDb(), repo: new BirthFakeRepo(), health: () => ({ databaseConfigured: true, restored: true }) });

test('PUBLISH-FIX-3: a fresh DB + new generation in DATA_ONLY commissions BOTH zero-budget checkpoints at zero (WIDE EYE / MARKET open, zero paid), and the durable row records BIRTH_ZERO_BUDGET', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'birth-'));
  const p = birthPersistence();
  try {
    const logs = [];
    const checkpoints = await openDataOnlyCheckpoints({ persistence: p, dataDir: dir, env: { SERPENT_DATA_ONLY: 'true', SERPENT_DATA_GENERATION: 'gen1' }, clock: () => 4242, log: (m) => logs.push(String(m)) });
    // neither budget nor market is blocked: an absent checkpoint on a fresh deployment is a newborn account, not a failure.
    assert.deepEqual(checkpoints.blockers, {}, 'no CHECKPOINT_ABSENT blocker on a fresh deployment');
    assert.ok(checkpoints.budget, 'the news budget governor is live (WIDE EYE can open)');
    assert.equal(checkpoints.budget.restored.estimatedMonthUsd, 0, 'born at zero spend');
    assert.ok(checkpoints.market, 'the market quota journal is live (MARKET can open)');
    assert.deepEqual(checkpoints.market.rows(), [], 'born with no reservations');
    // the durable rows carry the BIRTH_ZERO_BUDGET provenance, logged once each.
    for (const id of [EXTERNAL_CHECKPOINT_IDS.DATA_ONLY, EXTERNAL_CHECKPOINT_IDS.MARKET]) {
      assert.equal(p.repo.rows.get(id).state.commissioning.reason, 'BIRTH_ZERO_BUDGET DATA_ONLY gen1', id);
    }
    assert.equal(logs.filter((l) => /BIRTH_ZERO_BUDGET/.test(l)).length, 2, 'commissioning logged once per checkpoint');
    await checkpoints.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const MARKET_STATE = Object.freeze({
  version: MARKET_QUOTA_CHECKPOINT_VERSION,
  journalVersion: QUOTA_JOURNAL_VERSION,
  rows: Object.freeze([]),
});

function binding(id, initial, events, isStoreClosed) {
  let state = structuredClone(initial);
  let revision = 1;
  return Object.freeze({
    id,
    snapshot: () => structuredClone(state),
    revision: () => revision,
    failed: () => null,
    commit: async (next) => {
      if (isStoreClosed()) throw Object.assign(new Error('store closed before commit'), { code: 'STORE_CLOSED' });
      events.push(`commit:${id}`);
      state = structuredClone(next);
      revision += 1;
      return structuredClone(state);
    },
    update: async (reducer) => {
      if (isStoreClosed()) throw Object.assign(new Error('store closed before update'), { code: 'STORE_CLOSED' });
      events.push(`update:${id}`);
      const next = reducer(structuredClone(state));
      assert.equal(typeof next?.then, 'undefined', 'binding reducers must remain synchronous');
      state = structuredClone(next);
      revision += 1;
      return structuredClone(state);
    },
  });
}

function fakeOpenStore({ missing = null } = {}) {
  const events = [];
  const restores = [];
  let storeClosed = false;
  const states = {
    [EXTERNAL_CHECKPOINT_IDS.DATA_ONLY]: { version: 'budget-fixture', used: 7 },
    [EXTERNAL_CHECKPOINT_IDS.MARKET]: MARKET_STATE,
  };
  const openStore = async ({ persistence }) => {
    events.push('store:open');
    assert.deepEqual(persistence, { restored: true });
    return Object.freeze({
      restore: async (options) => {
        events.push(`restore:${options.id}`);
        restores.push(options);
        assert.equal(storeClosed, false, 'bindings cannot be restored after the store closes');
        if (options.id === missing) throw Object.assign(new Error('source checkpoint absent'), { code: 'CHECKPOINT_ABSENT' });
        return binding(options.id, states[options.id], events, () => storeClosed);
      },
      status: () => ({ closed: storeClosed }),
      close: async () => { events.push('store:close'); storeClosed = true; },
    });
  };
  return { openStore, events, restores, closed: () => storeClosed };
}

test('opens the PostgreSQL store before source bindings and commissions the zero-budget checkpoints at BIRTH_ZERO_BUDGET when absent', async () => {
  const fake = fakeOpenStore();
  const checkpoints = await openDataOnlyCheckpoints({
    persistence: { restored: true },
    dataDir: 'unused-fixture-root',
    env: { SOCIAL_VIDEO_ENABLED: 'false' },
    clock: () => 1234,
    openStore: fake.openStore,
  });

  assert.deepEqual(fake.events.slice(0, 3), [
    'store:open',
    `restore:${EXTERNAL_CHECKPOINT_IDS.DATA_ONLY}`,
    `restore:${EXTERNAL_CHECKPOINT_IDS.MARKET}`,
  ]);
  assert.deepEqual(fake.restores.map(({ id }) => id), [
    EXTERNAL_CHECKPOINT_IDS.DATA_ONLY,
    EXTERNAL_CHECKPOINT_IDS.MARKET,
  ]);
  for (const options of fake.restores) {
    // PUBLISH-FIX-3: both zero-budget checkpoints now carry a BIRTH_ZERO_BUDGET commission so an ABSENT checkpoint on a
    // fresh deployment is born at zero (with allowCreate) instead of blocking WIDE EYE / MARKET. The store still prefers a
    // durable or filesystem checkpoint; the birth commission is used only when both are absent.
    assert.equal(options.commission.allowCreate, true, `${options.id} commissions at zero when absent`);
    assert.match(options.commission.reason, /^BIRTH_ZERO_BUDGET (DATA_ONLY|PAPER) /, options.id);
    assert.equal(options.commission.ts, 1234);
    assert.equal(typeof options.validate, 'function');
    assert.equal(typeof options.loadLocal, 'function');
    assert.equal(options.importMeta.ts, 1234);
    assert.match(options.importMeta.reason, /filesystem accounting before republish/);
  }
  assert.equal(checkpoints.video, undefined, 'LEAN PASS 4a: there is no video checkpoint — the social-video tier is retired');
  await checkpoints.close();
});

test('a valid budget and exact market journal both restore and remain injectable (LEAN PASS 4a retired the discovery/youtube sources)', async () => {
  const fake = fakeOpenStore({});
  const checkpoints = await openDataOnlyCheckpoints({
    persistence: { restored: true },
    dataDir: 'unused-fixture-root',
    env: {},
    log: () => {},
    clock: () => 2000,
    openStore: fake.openStore,
  });

  assert.equal(checkpoints.discovery, undefined, 'LEAN PASS 4a: there is no discovery checkpoint');
  assert.deepEqual(checkpoints.budget.restored, { version: 'budget-fixture', used: 7 });
  assert.equal(checkpoints.market.durable, true);
  assert.deepEqual(checkpoints.market.rows(), []);

  const reservationId = await checkpoints.market.reserve({
    providerId: 'KRAKEN_SPOT',
    endpointId: 'KRAKEN_OHLC',
    unit: 'CALL',
    credits: 1,
    chargedOn: 'DISPATCH',
    purpose: 'ACQUIRE',
    requestKey: 'fixture-request',
    estimatedUsd: 0,
  });
  assert.match(reservationId, /^qr-[0-9a-f]{40}$/);
  assert.equal(checkpoints.market.rows().length, 1);
  assert.equal(checkpoints.market.rows()[0].type, 'RESERVE');
  assert.ok(fake.events.includes(`update:${EXTERNAL_CHECKPOINT_IDS.MARKET}`), 'the returned market journal mutates the exact restored market binding');
  await checkpoints.close();
});

test('close drains the market journal facade before closing its backing store', async () => {
  const fake = fakeOpenStore();
  const checkpoints = await openDataOnlyCheckpoints({
    persistence: { restored: true },
    dataDir: 'unused-fixture-root',
    env: {},
    clock: () => 3000,
    openStore: fake.openStore,
  });

  const reservation = checkpoints.market.reserve({
    providerId: 'COINBASE_SPOT',
    endpointId: 'COINBASE_CANDLES',
    unit: 'CALL',
    credits: 1,
    chargedOn: 'DISPATCH',
    purpose: 'ACQUIRE',
    requestKey: 'queued-before-close',
    estimatedUsd: 0,
  });
  const closing = checkpoints.close();
  await assert.doesNotReject(reservation);
  await assert.doesNotReject(closing);

  const updateAt = fake.events.indexOf(`update:${EXTERNAL_CHECKPOINT_IDS.MARKET}`);
  const closeAt = fake.events.indexOf('store:close');
  assert.ok(updateAt >= 0 && updateAt < closeAt, 'queued market accounting must become durable before the store lock is released');
  assert.equal(fake.closed(), true);
});
