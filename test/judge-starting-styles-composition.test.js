import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const isolatedData = mkdtempSync(path.join(tmpdir(), 'serpent-styles-composition-'));
process.env.COBRA_DATA_DIR = isolatedData;
const { composeJudge, initAccount } = await import('../judge/composition.js');
const { createMemoryJournal } = await import('../execution/journal.js');
const { loadJudgePolicy } = await import('../judge/policy.js');
const { STRATEGY_FAMILIES, strategyFamilyOf } = await import('../judge/setup-selection.js');
const { OPERATIONAL_EDGE_STRATEGY_VERSION } = await import('../judge/edge-state.js');
const { fakeClock, SPEC } = await import('./helpers/judge.js');
const candidateFile = path.resolve('config/judge.paper.starting-styles.json');
const baselineFile = path.resolve('config/judge.paper.json');
const candidate = loadJudgePolicy(candidateFile);
test.after(() => rmSync(isolatedData, { recursive: true, force: true }));

test('STRAT-C01: the explicit five-family policy preserves fees, limits and execution controls, without replacing the default', () => {
  const baseline = loadJudgePolicy(baselineFile);
  assert.equal(baseline.policy.policyVersion, 'judge-policy-1');
  assert.deepEqual(candidate.policy.fees, baseline.policy.fees);
  assert.equal(candidate.policy.fees.taker.rate, '0.008');
  assert.equal(candidate.policy.fees.taker.rateKind, 'PAPER_REFERENCE');
  assert.deepEqual(candidate.policy.limits, baseline.policy.limits);
  assert.deepEqual(candidate.policy.execution, baseline.policy.execution);
  assert.deepEqual(candidate.policy.universe, baseline.policy.universe);
  assert.deepEqual([...new Set(candidate.policy.setups.enabled.map(strategyFamilyOf))], STRATEGY_FAMILIES);
  assert.equal(candidate.policy.live, null);
  assert.equal(JSON.parse(readFileSync(baselineFile)).policyVersion, 'judge-policy-1');
});

test('STRAT-C02: normal composition supplies all five families and exact v2 ports, abstains without data, and reopens the same account without resetting cash', async () => {
  const clock = fakeClock();
  const journal = createMemoryJournal();
  const accountId = 'isolated-five-family-composition';
  await initAccount({ journal, policy: candidate.policy, policyDigest: candidate.digest,
    accountId, mode: 'PAPER', ownerRef: 'TEST_ONLY', nowTs: clock.now() });
  let transportCalls = 0;
  const options = {
    policyFile: candidateFile, mode: 'PAPER', accountId, journal, env: {},
    clock: { ...clock, observeWall: () => null, status: () => ({ trusted: true }), expired: (t) => clock.now() > t },
    specs: [SPEC], history: { bars: () => null }, caseSource: { consumed: () => null, status: () => ({}) },
    nominations: () => [{ symbol: 'XBT/USD', assetId: 'BTC', nominationKnownAtTs: clock.now() }],
    controlsSource: () => ({ kill: false, cage: false, vetoes: [] }),
    transport: async () => { transportCalls += 1; throw new Error('unexpected transport'); },
    allowPrivate: () => false, allowOrders: () => false,
    persistenceHealth: () => ({ allowPermissionIncrease: true }),
    writeProjection: false, codeDigest: 'f'.repeat(64), log: () => {},
  };
  let run = await composeJudge(options);
  try {
    assert.equal(run.adapter.kind, 'PAPER');
    assert.equal(run.credentialsPresent, false);
    assert.equal(run.keyFingerprint, null);
    assert.deepEqual(run.judge.status().setups, candidate.policy.setups.enabled);
    assert.equal(run.judge.status().strategyVersion, OPERATIONAL_EDGE_STRATEGY_VERSION);
    await run.start({ heartbeatMs: 60_000, schedulerMs: 60_000 });
    run.admitNominations();
    await run.tick();
    await run.judge.drain();
    assert.equal(run.judge.candidates().length, 1);
    assert.equal(run.judge.candidates()[0].indicators, null);
    assert.equal(run.judge.decisions().some((d) => d.status === 'ENTRY_RESERVED'), false);
    assert.deepEqual(Object.keys(run.dispatcher.state().positions), []);
    assert.deepEqual(Object.keys(run.dispatcher.state().orders), []);
    const before = run.dispatcher.state().cash;
    await run.stop(); run = null;
    const state = await journal.load(accountId);
    assert.equal(state.state.cash, before);
    assert.equal((await journal.replayVerify(accountId)).ok, true);
    run = await composeJudge(options);
    assert.equal(run.dispatcher.state().cash, before);
    assert.equal(run.dispatcher.state().policyDigest, candidate.digest);
    assert.deepEqual(run.judge.status().setups, candidate.policy.setups.enabled);
    assert.equal(transportCalls, 0, 'already supplied specs and missing observations never trigger private calls or invented facts');
  } finally { if (run) await run.stop(); }
});

test('STRAT-C03: a flag cannot promote the five-family PAPER policy to LIVE', async () => {
  await assert.rejects(composeJudge({ policyFile: candidateFile, mode: 'LIVE_ARMED', env: {}, log: () => {} }), /LIVE run needs a LIVE policy/);
});

test('STRAT-C04: selecting v2 for an existing v1 account refuses instead of silently migrating its ledger', async () => {
  const old = loadJudgePolicy(baselineFile); const journal = createMemoryJournal();
  const clock = fakeClock(); const accountId = 'isolated-existing-v1';
  await initAccount({ journal, policy: old.policy, policyDigest: old.digest, accountId, mode: 'PAPER', ownerRef: 'TEST_ONLY', nowTs: clock.now() });
  const before = await journal.load(accountId);
  await assert.rejects(composeJudge({ policyFile: candidateFile, mode: 'PAPER', accountId, journal,
    env: {}, clock, codeDigest: 'a'.repeat(64), writeProjection: false, log: () => {} }), /initialized under another policy binding/);
  const after = await journal.load(accountId);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.state, before.state);
});
