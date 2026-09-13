import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_SELECTION_VERSION,
  STRATEGY_FAMILIES,
  SETUP_FAMILY,
  strategyFamilyOf,
  deterministicSetupTieOrder,
  createUnderlyingClaimLedger,
  selectionMeasurement,
  setupDurationBound,
} from '../judge/setup-selection.js';
import { createJudge } from '../judge/judge.js';

const judgeConstructorArgs = () => ({
  accountId: 'setup-selection-constructor',
  policy: { setups: { enabled: [] } },
  policyDigest: 'a'.repeat(64),
  dispatcher: { ev: () => null, onCommit: () => {}, state: () => ({}) },
  feed: null,
  clock: { now: () => 0, monotonic: () => 0 },
  specOf: () => null,
  feeOf: () => null,
});

test('setupSelection is absent by default, activates only through the exact versioned port, and rejects malformed or future ports', () => {
  assert.doesNotThrow(() => createJudge(judgeConstructorArgs()));
  assert.doesNotThrow(() => createJudge({ ...judgeConstructorArgs(), setupSelection: { version: SETUP_SELECTION_VERSION } }));
  for (const setupSelection of [true, [], {}, { version: 'future-version' }, { version: SETUP_SELECTION_VERSION, enabled: false }]) {
    assert.throws(() => createJudge({ ...judgeConstructorArgs(), setupSelection }), /invalid setupSelection port/);
  }
});

test('null-horizon research evaluators cannot be activated through policy, enabledSetups, armRule, or setupSelection alone', () => {
  const port = { version: SETUP_SELECTION_VERSION };
  for (const setupId of ['MOMENTUM_CONTINUATION', 'MICRO_BITE']) {
    assert.throws(() => createJudge({ ...judgeConstructorArgs(), policy: { setups: { enabled: [setupId] } } }), /NEW_SETUP_NOT_OPERATIONAL/);
    assert.throws(() => createJudge({ ...judgeConstructorArgs(), enabledSetups: [setupId] }), /NEW_SETUP_NOT_OPERATIONAL/);
    assert.throws(() => createJudge({ ...judgeConstructorArgs(), mode: 'REPLAY', armRule: { setups: [setupId] } }), /NEW_SETUP_NOT_OPERATIONAL/);
    assert.throws(() => createJudge({ ...judgeConstructorArgs(), enabledSetups: [setupId], setupSelection: port }), /NEW_SETUP_NOT_OPERATIONAL/);
  }
  assert.doesNotThrow(() => createJudge({ ...judgeConstructorArgs(), enabledSetups: ['RANGE_IGNITION'], setupSelection: port }), 'the versioned selection port remains usable with an operational legacy setup');
});

test('six setup evaluators map exactly to five strategy families without collapsing distinct setups', () => {
  assert.equal(SETUP_SELECTION_VERSION, 'judge-setup-selection-1');
  assert.deepEqual(STRATEGY_FAMILIES, [
    'MOMENTUM_CONTINUATION',
    'EARLY_IGNITION_BREAKOUT',
    'PULLBACK_REENTRY',
    'RUMOR_CATALYST',
    'MICRO_BITE',
  ]);
  assert.equal(Object.keys(SETUP_FAMILY).length, 6);
  assert.equal(strategyFamilyOf('MOMENTUM_CONTINUATION'), 'MOMENTUM_CONTINUATION');
  assert.equal(strategyFamilyOf('RANGE_IGNITION'), 'EARLY_IGNITION_BREAKOUT');
  assert.equal(strategyFamilyOf('TREND_PULLBACK_CONTINUATION'), 'PULLBACK_REENTRY');
  assert.equal(strategyFamilyOf('ABSORPTION_RECLAIM'), 'PULLBACK_REENTRY');
  assert.equal(strategyFamilyOf('CATALYST_TRANSMISSION'), 'RUMOR_CATALYST');
  assert.equal(strategyFamilyOf('MICRO_BITE'), 'MICRO_BITE');
  assert.equal(strategyFamilyOf('UNKNOWN_SETUP'), null, 'unknown is never guessed into a family');
});

test('the setup pre-order supplies only a deterministic same-asset tie and does not mutate candidates', () => {
  const source = [
    { rank: { assetId: 'BTC', setupId: 'TREND_PULLBACK_CONTINUATION', decisionId: 'd3', rewardRiskRatio: 3, costBps: 4 } },
    { rank: { assetId: 'ETH', setupId: 'MICRO_BITE', decisionId: 'd4', rewardRiskRatio: 9, costBps: 1 } },
    { rank: { assetId: 'BTC', setupId: 'ABSORPTION_RECLAIM', decisionId: 'd2', rewardRiskRatio: 3, costBps: 4 } },
    { rank: { assetId: 'BTC', setupId: 'RANGE_IGNITION', decisionId: 'd1', rewardRiskRatio: 1, costBps: 9 } },
  ];
  const ordered = deterministicSetupTieOrder(source);
  assert.deepEqual(ordered.map((row) => [row.rank.assetId, row.rank.setupId]), [
    ['BTC', 'RANGE_IGNITION'],
    ['BTC', 'ABSORPTION_RECLAIM'],
    ['BTC', 'TREND_PULLBACK_CONTINUATION'],
    ['ETH', 'MICRO_BITE'],
  ]);
  assert.equal(source[0].rank.setupId, 'TREND_PULLBACK_CONTINUATION');
  assert.equal(ordered[0].rank.rewardRiskRatio, 1, 'this helper does not rank economics; risk.js still does that afterward');
});

test('selection measurements distinguish a commit attempt from an explicit same-underlying loser', () => {
  const selected = selectionMeasurement({ setupId: 'MICRO_BITE', selected: true, rank: 1, of: 2 });
  assert.deepEqual({ id: selected.id, ok: selected.ok, value: selected.value, threshold: selected.threshold, unit: selected.unit }, {
    id: 'STRATEGY_FAMILY_SELECTION', ok: true, value: 'MICRO_BITE', threshold: 'MICRO_BITE', unit: 'STRATEGY_FAMILY',
  });
  assert.match(selected.note, /selected_for_commit_attempt/);
  const loser = selectionMeasurement({ setupId: 'ABSORPTION_RECLAIM', selected: false, winnerSetupId: 'TREND_PULLBACK_CONTINUATION', rank: 2, of: 2 });
  assert.equal(loser.ok, false); assert.equal(loser.value, 'PULLBACK_REENTRY'); assert.equal(loser.threshold, 'PULLBACK_REENTRY'); assert.match(loser.note, /same_underlying_claimed/);
});

test('an underlying is claimed only after commit, so a failed preferred candidate leaves the next setup available', () => {
  const claims = createUnderlyingClaimLedger();
  const first = claims.offer({ assetId: 'BTC', setupId: 'MOMENTUM_CONTINUATION' });
  assert.equal(first.selected, true);
  assert.equal(claims.settle({ assetId: 'BTC', setupId: 'MOMENTUM_CONTINUATION', claimed: false }), null);
  const fallback = claims.offer({ assetId: 'BTC', setupId: 'RANGE_IGNITION' });
  assert.equal(fallback.selected, true, 'failure before the reservation/position transaction cannot consume the underlying');
  assert.equal(claims.settle({ assetId: 'BTC', setupId: 'RANGE_IGNITION', claimed: true }), 'RANGE_IGNITION');
  const loser = claims.offer({ assetId: 'BTC', setupId: 'MICRO_BITE' });
  assert.deepEqual(loser, { selected: false, winnerSetupId: 'RANGE_IGNITION', reason: 'STRATEGY_NOT_SELECTED_SAME_UNDERLYING' });
  assert.equal(claims.offer({ assetId: 'ETH', setupId: 'MICRO_BITE' }).selected, true, 'different assets are not forced into one global strategy');
  assert.deepEqual(claims.snapshot(), { BTC: 'RANGE_IGNITION' });
});

test('setup horizon can only shorten policy and an edge-state setup without an operational Watch horizon refuses', () => {
  assert.deepEqual(setupDurationBound({ policyMaxDurationMs: 14_400_000, setupMaxDurationMs: 3_600_000 }), { ok: true, maxDurationMs: 3_600_000, reason: null });
  assert.deepEqual(setupDurationBound({ policyMaxDurationMs: 300_000, setupMaxDurationMs: 14_400_000 }), { ok: true, maxDurationMs: 300_000, reason: null });
  assert.deepEqual(setupDurationBound({ policyMaxDurationMs: 14_400_000, setupMaxDurationMs: null }), { ok: false, maxDurationMs: null, reason: 'HORIZON_NOT_OPERATIONAL' });
  assert.equal(setupDurationBound({ policyMaxDurationMs: 0, setupMaxDurationMs: 300_000 }).reason, 'POLICY_DURATION_INVALID');
  assert.equal(setupDurationBound({ policyMaxDurationMs: 14_400_000, setupMaxDurationMs: -1 }).reason, 'SETUP_DURATION_INVALID');
});
