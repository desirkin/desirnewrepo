// PERSIST-1-1: durable authorization is a permission increase. The same
// composed persistence gate that fences entries must fence ACCOUNT_AUTHORIZED,
// while disarm and SAFETY work stay available under the lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { startPersistence } from '../persistence/runtime.js';
import { composeJudge, initAccount } from '../judge/composition.js';
import { createMemoryJournal } from '../execution/journal.js';
import { keyFingerprint } from '../execution/contract.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { prepareRelease, approveRelease } from '../judge/arming.js';
import { fakeClock, holdoutChainFixture, SAMPLE_LIMITS, SPEC, T0 } from './helpers/judge.js';

const SUITE_ROOT = mkdtempSync(path.join(tmpdir(), 'persist-arm-lock-'));
const CODE = 'c'.repeat(64);
const KEY = 'SYNTHETIC-PERSIST-ARM-KEY';
const SECRET = 'SYNTHETIC-PERSIST-ARM-SECRET';
const paperRaw = JSON.parse(readFileSync(path.resolve('judge/samples/policy.paper-reference.json'), 'utf8'));
const POLICY_FILE = path.join(SUITE_ROOT, 'policy.live.json');
writeFileSync(POLICY_FILE, JSON.stringify({
  ...paperRaw,
  policyName: 'persist-arm-lock-live',
  mode: 'LIVE',
  account: { accountId: 'persist-arm-default', initialCapital: '500', compounding: 'NONE' },
  execution: { ...paperRaw.execution, adapter: 'KRAKEN' },
  live: {
    allocationCeiling: '500', reinvestment: 'NONE', ownerLimits: null,
    armExpiryMs: 7 * 86_400_000, canaryMaxBuyConsiderationWithFees: '25',
    keyEnv: 'PERSIST_ARM_TEST_KEY', secretEnv: 'PERSIST_ARM_TEST_SECRET',
  },
  authorityNote: 'Synthetic offline authorization fixture.',
}));
const POLICY = loadJudgePolicy(POLICY_FILE);
const ENV = { PERSIST_ARM_TEST_KEY: KEY, PERSIST_ARM_TEST_SECRET: SECRET };
const HOLDOUT = (({ __store, ...chain }) => chain)(await holdoutChainFixture({
  experimentId: 'persist-arm-lock-holdout', policyDigest: POLICY.digest,
  codeDigest: CODE, strategyVersion: POLICY.policy.strategyVersion,
  accountId: 'persist-arm-paper-evidence', nowTs: T0,
}));
const manifest = prepareRelease({
  holdoutChain: HOLDOUT, codeTreeDigest: CODE, policy: POLICY.policy, policyDigest: POLICY.digest,
  evaluation: {
    paperAccountId: 'persist-arm-paper-evidence', forwardClosedTrades: 40,
    holdoutUntouched: true, netPnl: '12.5', drawdown: 0.03,
    feesAccounted: true, openPositions: 0, evaluationDigest: 'e'.repeat(64), source: 'FORWARD_PAPER',
  },
  tests: { criticalSuitesPassing: true, evidenceFile: 'offline/persist-arm-lock' },
  sourcePrefixes: ['journal:persist-arm-paper-evidence:0123456789abcdef'],
  coverage: { dataFamilies: ['BOOK'], latencySamples: 100 },
  acceptance: { independentReview: 'PASSED', reviewer: 'persist-arm-lock-test' },
  proposedLimits: SAMPLE_LIMITS, nowTs: T0,
});
const approved = approveRelease({
  manifest, manifestDigest: manifest.manifestDigest,
  assessment: 'Offline fixture with explicit uncertainty and risk; it grants no production authority.',
  ownerRef: 'persist-arm-owner', sessionTag: 'persistarmtest', nowTs: T0,
});
assert.equal(approved.ok, true, approved.reason);
const APPROVAL = approved.approval;

const anchorPayload = '{"observation":1}\n';
const ANCHOR = Object.freeze({
  anchorVersion: 'store-anchor-1', storeId: 'study:persist-arm',
  relativePath: 'learning/observations.jsonl', format: 'JSONL', storeVersion: 'test-1',
  recordCount: 1, byteCount: Buffer.byteLength(anchorPayload),
  headDigest: createHash('sha256').update(anchorPayload).digest('hex'),
  headTs: 1, revision: 1,
});

function fakePool() {
  const query = async (sql) => {
    const text = String(sql);
    if (text.includes('SELECT version FROM serpent_schema_migrations')) {
      return { rows: Array.from({ length: SCHEMA_VERSION }, (_, i) => ({ version: i + 1 })), rowCount: SCHEMA_VERSION };
    }
    if (text.includes('FROM serpent_store_anchors')) {
      const { revision, ...metadata } = ANCHOR;
      return { rows: [{
        store_id: ANCHOR.storeId, relative_path: ANCHOR.relativePath, revision,
        metadata, payload: anchorPayload, payload_digest: ANCHOR.headDigest,
        byte_count: ANCHOR.byteCount,
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}

async function persistenceFixture(t, state) {
  const root = mkdtempSync(path.join(tmpdir(), `persist-arm-${state.toLowerCase()}-`));
  const previous = process.env.COBRA_DATA_DIR;
  process.env.COBRA_DATA_DIR = root;
  const file = path.join(root, ANCHOR.relativePath);
  if (state !== 'WIPED') {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, state === 'UNANCHORED_WRITES' ? `${anchorPayload}{"later":2}\n` : anchorPayload);
  }
  const persistence = await startPersistence({
    log: () => {}, registerSignals: false,
    dbOverrides: { url: 'postgresql://offline-fake/persist-arm', poolFactory: fakePool, retries: 1 },
  });
  t.after(async () => {
    await persistence.stop();
    if (previous === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return persistence;
}

const pclock = (clock) => ({
  now: clock.now, monotonic: clock.monotonic, observeWall: () => null,
  status: () => ({ trusted: true, kind: 'TEST' }), expired: (ts) => clock.now() > ts,
});

async function liveRun({ accountId, permissionIncreaseAllowed = null }) {
  const clock = fakeClock();
  const journal = createMemoryJournal();
  await initAccount({
    journal, policy: POLICY.policy, policyDigest: POLICY.digest, mode: 'LIVE_UNARMED',
    ownerRef: 'persist-arm-owner', nowTs: clock.now(), accountId,
  });
  const run = await composeJudge({
    policyFile: POLICY_FILE, mode: 'LIVE_UNARMED', accountId, env: ENV, journal,
    clock: pclock(clock), specs: [SPEC], nominations: () => [], writeProjection: false,
    codeDigest: CODE, log: () => {}, permissionIncreaseAllowed,
  });
  return { run, clock };
}

function armArgs(accountId, clock) {
  return {
    ownerLimits: SAMPLE_LIMITS, expiresTs: clock.now() + 600_000,
    allocationCeiling: '25', approval: APPROVAL, ownerRef: 'persist-arm-owner',
    releaseDigest: APPROVAL.releaseDigest,
    canary: {
      pair: 'XBT/USD', maxBuyConsiderationWithFees: '25',
      maxDurationMs: 600_000, lossAcknowledged: true,
    },
    preflight: {
      ok: true, accountId, policyDigest: POLICY.digest,
      keyFingerprint: keyFingerprint(KEY), ts: clock.now(),
      checks: { balance: { quoteAvailable: '500' } },
    },
  };
}

async function releaseRun(run) {
  await run.writer.release();
}

for (const state of ['WIPED', 'UNANCHORED_WRITES']) {
  test(`composed ARM refuses a commissioned ${state} cache even when a caller predicate says true`, { concurrency: false }, async (t) => {
    const persistence = await persistenceFixture(t, state);
    const health = persistence.health();
    assert.equal(health.permissionLock, true);
    assert.equal(health.storeGuard.stores[0].status, state);
    const { run, clock } = await liveRun({ accountId: `arm-${state.toLowerCase()}`, permissionIncreaseAllowed: () => true });
    const before = run.dispatcher.revision();
    try {
      const result = await run.arm(armArgs(run.accountId, clock));
      assert.deepEqual(result, { ok: false, reasons: ['PERSISTENCE_PERMISSION_LOCK'], state: 'BLOCKED' });
      assert.equal(run.dispatcher.revision(), before, 'refusal changes no durable account revision');
      assert.equal(run.dispatcher.state().authorization, null);
    } finally { await releaseRun(run); }
  });
}

test('ARM consumes and refuses a rejecting thenable without an unhandled rejection', { concurrency: false }, async (t) => {
  const persistence = await persistenceFixture(t, 'HEALTHY');
  assert.equal(persistence.health().permissionLock, false);
  let unhandled = null;
  const listener = (reason) => { unhandled = reason; };
  process.once('unhandledRejection', listener);
  const { run, clock } = await liveRun({
    accountId: 'arm-thenable', permissionIncreaseAllowed: () => Promise.reject(new Error('invalid async permission')),
  });
  const before = run.dispatcher.revision();
  try {
    const result = await run.arm(armArgs(run.accountId, clock));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(result, { ok: false, reasons: ['PERSISTENCE_PERMISSION_LOCK'], state: 'BLOCKED' });
    assert.equal(unhandled, null);
    assert.equal(run.dispatcher.revision(), before);
  } finally {
    process.removeListener('unhandledRejection', listener);
    await releaseRun(run);
  }
});

test('serialized ARM recheck catches a gate flip; a healthy ARM succeeds and later disarm/SAFETY remain usable under lock', { concurrency: false }, async (t) => {
  const persistence = await persistenceFixture(t, 'HEALTHY');
  assert.equal(persistence.health().permissionLock, false);

  let checks = 0;
  const flipped = await liveRun({
    accountId: 'arm-flip-before-append',
    permissionIncreaseAllowed: () => { checks += 1; return checks < 2; },
  });
  const beforeFlip = flipped.run.dispatcher.revision();
  try {
    const refused = await flipped.run.arm(armArgs(flipped.run.accountId, flipped.clock));
    assert.equal(checks, 2, 'checked immediately before enqueue and again inside the serialized commit boundary');
    assert.deepEqual(refused, { ok: false, reasons: ['PERSISTENCE_PERMISSION_LOCK'], state: 'BLOCKED' });
    assert.equal(flipped.run.dispatcher.revision(), beforeFlip);
    assert.equal(flipped.run.dispatcher.state().authorization, null);
  } finally { await releaseRun(flipped.run); }

  let allowed = true;
  const healthy = await liveRun({ accountId: 'arm-healthy', permissionIncreaseAllowed: () => allowed });
  const before = healthy.run.dispatcher.revision();
  try {
    const armed = await healthy.run.arm(armArgs(healthy.run.accountId, healthy.clock));
    assert.equal(armed.ok, true, JSON.stringify(armed));
    assert.equal(healthy.run.dispatcher.revision(), before + 1);
    assert.equal(healthy.run.dispatcher.state().authorization.ended, false);

    allowed = false;
    const safety = await healthy.run.dispatcher.enqueue('SAFETY', async () => 'PROTECTIVE_WORK_RAN');
    assert.equal(safety, 'PROTECTIVE_WORK_RAN');
    const ended = await healthy.run.disarm('REVOKED');
    assert.equal(ended.ok, true);
    assert.equal(healthy.run.dispatcher.state().authorization.ended, true);
    assert.equal(healthy.run.dispatcher.state().authorization.endedReason, 'REVOKED');
  } finally { await releaseRun(healthy.run); }
});

test.after(() => rmSync(SUITE_ROOT, { recursive: true, force: true }));
