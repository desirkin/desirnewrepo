import test from 'node:test';
import assert from 'node:assert/strict';
import { openDataOnlyCheckpoints } from '../tools/data-only-checkpoints.mjs';
import { EXTERNAL_CHECKPOINT_IDS } from '../persistence/external-checkpoint-store.js';
import { MARKET_QUOTA_CHECKPOINT_VERSION } from '../market-lab/external-quota-journal.js';
import { QUOTA_JOURNAL_VERSION } from '../market-lab/quota.js';

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

test('opens the PostgreSQL store before source bindings and never supplies implicit zero commissioning', async () => {
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
    assert.equal(Object.hasOwn(options, 'commission'), false, `${options.id} must not create a zero checkpoint`);
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
