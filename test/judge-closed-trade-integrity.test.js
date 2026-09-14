import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, DISPATCHER_DEFAULTS } from '../execution/dispatcher.js';
import { evaluateAccount, experienceLedger, isExecutedClosedPosition, isUnexecutedFlatPosition, isUnscorableExecutedClosedPosition } from '../judge/challengers.js';
import { assignGroups, declareExperiment, evaluateSplit } from '../judge/experiment.js';
import * as Replay from '../judge/experiment-replay.js';
import { paperAccount, SPEC, TAKER_FEE, syntheticReport, T0 } from './helpers/judge.js';

function adapter() {
  return {
    kind: 'PAPER',
    stopAdmission() {},
    async drain() { return {}; },
    async submitEntryWithProtection() { throw new Error('the queue-refused fixture must never call the adapter'); },
    async reconcile() { return { outcome: 'COMPLETE', unmatched: 0, pageIncomplete: false, reason: null }; },
  };
}

async function appendBreakevenTrade(dispatcher, F, clock) {
  await dispatcher.commit([
    F.hypothesis('real-d'),
    F.decision('real-d'),
    F.reserve('real-r', 'real-d'),
    F.position('real-p', 'real-d'),
    F.ev('FEED_PIN', { symbol: 'XBT/USD', action: 'PIN', reason: 'real position shell', ts: clock.now() }),
    F.intent('real-o', 'real-p', 'real-r'),
    F.attempt('real-o'),
    F.result('real-o', 'ACKNOWLEDGED'),
    F.fill('real-o', 'real-buy', { fee: { asset: 'USD', amount: '0' } }),
    F.orderState('real-o', 'FILLED', { nativeOrderId: 'nat-real-o', nativeCumQty: '0.001' }),
    F.release('real-r', { reason: 'ORDER_TERMINAL', releasedCash: '0.8', releasedRisk: '0' }),
    F.sellIntent('real-s', 'real-p', { limitPrice: '100000' }),
    F.attempt('real-s'),
    F.result('real-s', 'ACKNOWLEDGED'),
    F.fill('real-s', 'real-sell', { side: 'sell', quote: '100', price: '100000', fee: { asset: 'USD', amount: '0' } }),
    F.orderState('real-s', 'FILLED', { nativeOrderId: 'nat-real-s', nativeCumQty: '0.001' }),
    F.closed('real-p', 'FLAT', { residualBase: '0' }),
  ]);
}

async function appendExecutedUnknownTrade(dispatcher, F, clock) {
  await dispatcher.commit([
    F.hypothesis('unknown-d'),
    F.decision('unknown-d'),
    F.reserve('unknown-r', 'unknown-d'),
    F.position('unknown-p', 'unknown-d'),
    F.ev('FEED_PIN', { symbol: 'XBT/USD', action: 'PIN', reason: 'unknown-p', ts: clock.now() }),
    F.intent('unknown-o', 'unknown-p', 'unknown-r'),
    F.attempt('unknown-o'),
    F.result('unknown-o', 'ACKNOWLEDGED'),
    F.fill('unknown-o', 'unknown-buy', { fee: { asset: 'EUR', amount: '0.2' } }),
    F.orderState('unknown-o', 'FILLED', { nativeOrderId: 'nat-unknown-o', nativeCumQty: '0.001' }),
    F.release('unknown-r', { reason: 'ORDER_TERMINAL', releasedCash: '0.8', releasedRisk: '0' }),
    F.sellIntent('unknown-s', 'unknown-p', { limitPrice: '100000' }),
    F.attempt('unknown-s'),
    F.result('unknown-s', 'ACKNOWLEDGED'),
    F.fill('unknown-s', 'unknown-sell', { side: 'sell', quote: '100', price: '100000', fee: { asset: 'USD', amount: '0' } }),
    F.orderState('unknown-s', 'FILLED', { nativeOrderId: 'nat-unknown-s', nativeCumQty: '0.001' }),
    F.closed('unknown-p', 'FLAT', { residualBase: '0' }),
  ]);
}

test('queue-compensated zero-fill shells stay outside closed-trade and P&L evidence while real breakeven fills remain', async () => {
  const r = await paperAccount({ accountId: 'closed-trade-integrity' });
  await r.append([r.F.hypothesis('fake-d'), r.F.decision('fake-d'), r.F.reserve('fake-r', 'fake-d'), r.F.position('fake-p', 'fake-d'), r.F.pin(), r.F.intent('fake-o', 'fake-p', 'fake-r')]);
  const dispatcher = createDispatcher({ accountId: r.accountId, journal: r.journal, writer: r.writer, adapter: adapter(), clock: r.clock, feed: { release() {}, health: () => ({ usable: true }) }, specOf: () => SPEC, feeOf: () => TAKER_FEE, limits: { ...DISPATCHER_DEFAULTS, maxEntryQueue: 1 } });
  await dispatcher.load();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const active = dispatcher.enqueue('ENTRY', () => held);
  const queued = dispatcher.enqueue('ENTRY', async () => null);
  await assert.rejects(dispatcher.queueEntry('fake-o'), (error) => error.code === 'ENTRY_QUEUE_FULL');
  release(); await Promise.all([active, queued]);

  const compensated = dispatcher.state().positions['fake-p'];
  assert.equal(compensated.state, 'FLAT');
  assert.equal(compensated.firstFillTs, null);
  assert.equal(compensated.realizedPnl, '0', 'accounting may close the empty shell at zero without making it a trade');
  assert.equal(isExecutedClosedPosition(compensated), false);
  let evaluation = evaluateAccount(dispatcher.state(), { arm: 'REF_COMBINED' });
  assert.equal(evaluation.denominators.positions, 1);
  assert.equal(evaluation.denominators.closed, 0);
  assert.equal(evaluation.denominators.unexecutedFlat, 1);
  assert.equal(evaluation.denominators.unscorableExecutedClosed, 0);
  assert.equal(evaluation.support.closedTrades, 0);
  assert.equal(evaluation.support.unexecutedFlat, 1);
  assert.equal(evaluation.support.unscorableExecutedClosed, 0);
  assert.equal(evaluation.netPnl, '0');

  await appendBreakevenTrade(dispatcher, r.F, r.clock);
  evaluation = evaluateAccount(dispatcher.state(), { arm: 'REF_COMBINED' });
  assert.equal(isExecutedClosedPosition(dispatcher.state().positions['real-p']), true);
  assert.equal(evaluation.denominators.positions, 2);
  assert.equal(evaluation.denominators.closed, 1, 'only the economically executed round trip enters the sample');
  assert.equal(evaluation.denominators.unexecutedFlat, 1, 'the compensated shell remains visible rather than silently disappearing');
  assert.equal(evaluation.support.closedTrades, 1);
  assert.equal(evaluation.netPnl, '0', 'a genuine breakeven trade is retained');
  assert.equal(evaluation.wins, 0);
  assert.equal(evaluation.losses, 0);

  await appendExecutedUnknownTrade(dispatcher, r.F, r.clock);
  const unknown = dispatcher.state().positions['unknown-p'];
  assert.equal(unknown.state, 'FLAT');
  assert.ok(Number.isSafeInteger(unknown.firstFillTs));
  assert.equal(unknown.pnlUnknown, true, 'the real reducer marks an unconverted third-asset fee unknown');
  assert.equal(unknown.realizedPnl, null);
  assert.equal(isUnexecutedFlatPosition(unknown), false);
  assert.equal(isUnscorableExecutedClosedPosition(unknown), true);
  assert.equal(isExecutedClosedPosition(unknown), false);
  evaluation = evaluateAccount(dispatcher.state(), { arm: 'REF_COMBINED' });
  assert.equal(evaluation.denominators.positions, 3);
  assert.equal(evaluation.denominators.closed, 1, 'only the known-P&L executed close enters P&L evidence');
  assert.equal(evaluation.denominators.unexecutedFlat, 1, 'only the zero-fill compensated shell is unexecuted');
  assert.equal(evaluation.denominators.unscorableExecutedClosed, 1, 'the executed close with an unknown fee conversion remains visible');
  assert.equal(evaluation.support.closedTrades, 1);
  assert.equal(evaluation.support.unscorableExecutedClosed, 1);
  assert.equal(evaluation.netPnl, '0');
  assert.deepEqual(experienceLedger(dispatcher.state()).rows.filter((row) => row.positionId === 'unknown-p'), [{
    kind: 'UNSCORABLE_COUNTERFACTUAL', positionId: 'unknown-p', fact: 'executed close has unknown realized P&L',
  }]);

  const replay = await r.journal.replayVerify(r.accountId);
  assert.equal(replay.ok, true);
  const restored = await r.journal.load(r.accountId);
  const afterRestart = evaluateAccount(restored.state, { arm: 'REF_COMBINED' });
  assert.equal(afterRestart.support.closedTrades, 1);
  assert.equal(afterRestart.support.unexecutedFlat, 1);
  assert.equal(afterRestart.support.unscorableExecutedClosed, 1);
  assert.equal(afterRestart.denominators.unscorableExecutedClosed, 1);
  assert.equal(afterRestart.netPnl, '0');
});

test('the report-level closed-trade predicate cannot turn a rehashed flat shell into an outcome', () => {
  assert.equal(isExecutedClosedPosition({ state: 'FLAT', realizedPnl: '999', firstFillTs: null }), false);
  assert.equal(isExecutedClosedPosition({ state: 'FLAT', realizedPnl: '0', firstFillTs: 1 }), true);
  assert.equal(isExecutedClosedPosition({ state: 'OPEN', realizedPnl: '999', firstFillTs: 1 }), false);
  assert.equal(isUnexecutedFlatPosition({ state: 'FLAT', realizedPnl: null, firstFillTs: 1 }), false);
  assert.equal(isUnscorableExecutedClosedPosition({ state: 'FLAT', realizedPnl: null, firstFillTs: 1 }), true);
});

test('prospective split evaluation excludes an unexecuted flat shell without excluding a genuine breakeven close', () => {
  const day = 86_400_000;
  const declaration = declareExperiment({
    experimentId: 'closed-trade-split-integrity', policyDigest: 'a'.repeat(64), codeDigest: 'c'.repeat(64), strategyVersion: 'judge-strategy-paper-reference-1', arms: ['REF_COMBINED', 'CASH'], seed: 'closed-trade-integrity-seed', sourceBinding: { sourcePrefix: 'journal:closed-trade-integrity', accountId: 'closed-trade-integrity' }, startTs: T0 + 60_000, durationMs: 6 * day, fractions: { developmentFraction: 0.5, validationFraction: 0.25 }, embargoMs: 0, horizons: { lookbackMs: 0, decisionMs: 0, maxOutcomeMs: 0, publicationFloorMs: 0 }, nowTs: T0,
  });
  const decisionTs = declaration.windows.startTs + 1000;
  const episodeId = 'episode-real-breakeven';
  const decisionId = 'decision-real-breakeven';
  const report = syntheticReport({ declaration, arms: ['REF_COMBINED', 'CASH'], episodes: { REF_COMBINED: [{ episodeId, decisionId, ts: decisionTs, pnl: '0' }] }, evidenceScope: { stage: 'DEVELOPMENT', boundaryTs: declaration.windows.developmentEndTs }, replay: Replay });
  report.arms.REF_COMBINED.positions.push({ positionId: 'pos-unexecuted-shell', decisionId, assetId: 'BTC', pair: 'XBT/USD', state: 'FLAT', realizedPnl: '0', firstFillTs: null, lastEconomicTs: null, exitReason: 'ENTRY_QUEUE_REFUSED' });
  report.arms.REF_COMBINED.positions.push({ positionId: 'pos-unscorable-close', decisionId, assetId: 'BTC', pair: 'XBT/USD', state: 'FLAT', realizedPnl: null, firstFillTs: decisionTs + 600, lastEconomicTs: decisionTs + 1000, exitReason: 'FEE_CONVERSION_UNKNOWN' });
  report.reportDigest = Replay.reportDigestOf(report);
  const assignment = assignGroups(declaration, [{ groupId: episodeId, level: 'EPISODE', firstKnownTs: decisionTs, decisionTs, outcomeEndTs: decisionTs + 1, arrivedTs: decisionTs, dependencies: { caseId: null, catalystId: null, sourceId: null } }], { nowTs: declaration.windows.developmentEndTs + 1 });
  const evaluation = evaluateSplit({ declaration, assignment, report, split: 'DEVELOPMENT', nowTs: declaration.windows.developmentEndTs + 1 });
  assert.equal(evaluation.arms.REF_COMBINED.entries, 1);
  assert.equal(evaluation.arms.REF_COMBINED.closed, 1);
  assert.equal(evaluation.arms.REF_COMBINED.censored, 1, 'the executed close with unknown P&L remains an incomplete outcome');
  assert.equal(evaluation.arms.REF_COMBINED.netPnl, '0');
});
