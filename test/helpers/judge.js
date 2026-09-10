// JUDGE / EXECUTION shared fixture builder (ticket §1): one builder, separate dirs / accounts per case, a fake clock, a
// scripted venue, an isolated PostgreSQL schema on the established loopback cluster. Every helper is offline.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeEvent, instrumentSpec, feeContract, digestOf } from '../../execution/contract.js';
import { createMemoryJournal } from '../../execution/journal.js';
import * as M from '../../execution/money.js';

export const T0 = Date.parse('2026-09-08T12:00:00Z');
export const tmp = (prefix = 'judge-') => mkdtempSync(path.join(tmpdir(), prefix));
export const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
// a fake clock: wall + monotonic advance together unless the test moves one (rollback / suspend drills)
export function fakeClock(start = T0) { let wall = start; let mono = 0; const c = { now: () => wall, monotonic: () => mono, advance: (ms) => { wall += ms; mono += ms; return wall; }, setWall: (v) => { wall = v; }, advanceMonotonic: (ms) => { mono += ms; } }; return c; }
export const SAMPLE_LIMITS = Object.freeze({ maxSimultaneousAssetPositions: 3, maxModelledRiskPerPositionFraction: 0.01, maxAggregateModelledRiskFraction: 0.02, maxCorrelatedClusterModelledRiskFraction: 0.015, dailyLossRestrictionFraction: 0.05, peakEquityDrawdownRestrictionFraction: 0.1, maxGrossExposureFraction: 1, maxAssetExposureFraction: 1 });
export const POLICY_DIGEST = 'a'.repeat(64); export const HEX = (c) => String(c).repeat(64).slice(0, 64);
export const SPEC = instrumentSpec({ venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online', priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005', costMin: '0.5', priceDecimals: 1, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
export const SOL_SPEC = instrumentSpec({ venue: 'kraken', pairKey: 'SOLUSD', altname: 'SOLUSD', wsname: 'SOL/USD', base: 'SOL', quote: 'ZUSD', canonicalCoin: 'SOL', status: 'online', priceIncrement: '0.01', qtyIncrement: '0.00000001', orderMin: '0.02', costMin: '0.5', priceDecimals: 2, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
export const TAKER_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.008', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'cobra.config.json fees 2026-09-02 kraken taker', observedTs: T0 });
// event factory bound to one account + clock (knownAtTs = clock.now() unless given)
export function eventsFor(accountId, clock) {
  const ev = (type, payload, extra = {}) => makeEvent({ type, accountId, payload, knownAtTs: extra.knownAtTs ?? clock.now(), causeId: extra.causeId ?? null });
  const F = {
    ev,
    init: (over = {}) => ev('ACCOUNT_INITIALIZED', { accountKind: 'PAPER', initialCapital: '500', quote: 'USD', venue: 'kraken', policyDigest: POLICY_DIGEST, policyVersion: 'judge-policy-paper-reference-1', ownerRef: 'owner-test', sessionDate: '2026-09-08', clockAnchorTs: clock.now(), limits: SAMPLE_LIMITS, compounding: 'NONE', ...over }),
    hypothesis: (decisionId, over = {}) => ev('HYPOTHESIS_LOCKED', { decisionId, episodeId: `ep-${decisionId}`, setupId: 'RANGE_IGNITION', assetId: 'BTC', pair: 'XBT/USD', hypothesisDigest: HEX('b'), frozenAtTs: clock.now(), triggerTs: clock.now(), expiresTs: clock.now() + 10_000, ...over }),
    decision: (decisionId, over = {}) => ev('DECISION_RECORDED', { decisionId, episodeId: `ep-${decisionId}`, assetId: 'BTC', pair: 'XBT/USD', setupId: 'RANGE_IGNITION', inputMode: 'MARKET_DIRECT', state: 'ENTRY_PROPOSED', reasonCodes: [], decisionKnownAtTs: clock.now(), decisionDigest: HEX('d'), sizing: { q: '0.001', entryLimitPrice: '100000', entryCashOut: '100.8', riskUsd: '4', bufferedScenarioNetProfit: '2' }, strategyVersion: 'judge-strategy-paper-reference-1', policyDigest: POLICY_DIGEST, ...over }),
    reserve: (reservationId, decisionId, over = {}) => ev('RESERVATION_OPENED', { reservationId, decisionId, assetId: 'BTC', pair: 'XBT/USD', cashReserved: '100.8', riskReserved: '4', clusterId: 'BTC', expiresTs: clock.now() + 10_000, ...over }),
    release: (reservationId, over = {}) => ev('RESERVATION_RELEASED', { reservationId, reason: 'CONSUMED', releasedCash: '0', releasedRisk: '0', ts: clock.now(), ...over }),
    position: (positionId, decisionId, over = {}) => ev('POSITION_OPENED', { positionId, decisionId, assetId: 'BTC', pair: 'XBT/USD', specDigest: SPEC.specDigest, structuralStop: '99000', targetPrice: '102000', targetProceedsRecipe: 'SHIFTED_BOOK_STRESS_50', atr14: '200', maxDurationMs: 4 * 3_600_000, feedPinned: true, requestedQty: '0.001', clusterId: 'BTC', ...over }),
    pin: (symbol = 'XBT/USD', action = 'PIN') => ev('FEED_PIN', { symbol, action, reason: 'position shell', ts: clock.now() }),
    intent: (orderId, positionId, reservationId, over = {}) => ev('ORDER_INTENT', { intentId: `int-${orderId}`, orderId, clientOrderId: `cl-${orderId}`, reservationId, positionId, kind: 'ENTRY', side: 'buy', pair: 'XBT/USD', qty: '0.001', limitPrice: '100000', orderType: 'limit', timeInForce: 'IOC', protection: { ordertype: 'stop-loss', trigger: 'last', price: '99000' }, deadlineTs: clock.now() + 3000, feeDigest: TAKER_FEE.feeDigest, specDigest: SPEC.specDigest, snapshotDigest: HEX('e'), createdTs: clock.now(), ...over }),
    sellIntent: (orderId, positionId, over = {}) => ev('ORDER_INTENT', { intentId: `int-${orderId}`, orderId, clientOrderId: `cl-${orderId}`, reservationId: null, positionId, kind: 'PLANNED_EXIT', side: 'sell', pair: 'XBT/USD', qty: '0.001', limitPrice: '99500', orderType: 'limit', timeInForce: 'IOC', protection: null, deadlineTs: clock.now() + 3000, feeDigest: TAKER_FEE.feeDigest, specDigest: SPEC.specDigest, snapshotDigest: HEX('e'), createdTs: clock.now(), ...over }),
    stopIntent: (orderId, positionId, over = {}) => ev('ORDER_INTENT', { intentId: `int-${orderId}`, orderId, clientOrderId: `cl-${orderId}`, reservationId: null, positionId, kind: 'PROTECTIVE_STOP', side: 'sell', pair: 'XBT/USD', qty: '0.001', limitPrice: '99000', orderType: 'stop-loss', timeInForce: 'GTC', protection: null, deadlineTs: null, feeDigest: TAKER_FEE.feeDigest, specDigest: SPEC.specDigest, snapshotDigest: null, createdTs: clock.now(), ...over }),
    attempt: (orderId, attemptId = `att-${orderId}`, adapter = 'PAPER') => ev('DISPATCH_ATTEMPTED', { orderId, attemptId, adapter, ts: clock.now() }),
    result: (orderId, outcome, over = {}) => ev('DISPATCH_RESULT', { orderId, attemptId: `att-${orderId}`, outcome, nativeOrderId: outcome === 'ACKNOWLEDGED' ? `nat-${orderId}` : null, reason: null, sourceTs: clock.now(), receiptTs: clock.now(), guaranteesNoAcceptance: outcome === 'REJECTED', ...over }),
    fill: (orderId, execId, over = {}) => ev('EXECUTION_RECORDED', { orderId, execId, nativeOrderId: `nat-${orderId}`, side: 'buy', base: '0.001', quote: '100', price: '100000', fee: { asset: 'USD', amount: '0.8' }, sourceTs: clock.now(), receiptTs: clock.now(), origin: 'PAPER', ordRefId: null, nativeCumQty: null, sequence: null, ...over }),
    orderState: (orderId, state, over = {}) => ev('ORDER_STATE', { orderId, state, nativeOrderId: null, nativeCumQty: null, reason: null, sourceTs: clock.now(), receiptTs: clock.now(), ...over }),
    protection: (positionId, state, over = {}) => ev('PROTECTION_STATE', { positionId, orderId: null, state, nativeOrderId: null, trigger: '99000', qty: '0.001', sourceTs: clock.now(), receiptTs: clock.now(), reason: null, ...over }),
    amend: (positionId, orderId, amendId, outcome, over = {}) => ev('PROTECTION_AMEND', { positionId, orderId, amendId, requestedTrigger: '99500', outcome, confirmedTrigger: outcome === 'ACKNOWLEDGED' ? '99500' : null, receiptTs: clock.now(), reason: null, ...over }),
    r: (positionId, state, over = {}) => ev('POSITION_R', { positionId, state, initialR: state === 'FINAL' ? '1.8' : null, entryVwap: '100000', entryCashOut: '100.8', confirmedBase: '0.001', reason: null, ts: clock.now(), ...over }),
    watch: (positionId, over = {}) => ev('WATCH_STATE', { positionId, trailActive: false, highestBid: null, exitState: 'NONE', primaryReason: null, priority: null, supportedReasons: [], ts: clock.now(), ...over }),
    closed: (positionId, state = 'FLAT', over = {}) => ev('POSITION_CLOSED', { positionId, reason: 'target', residualBase: '0', state, ts: clock.now(), ...over }),
    valuation: (over = {}) => ev('VALUATION', { ts: clock.now(), cashComponent: '500', liquidationComponent: '0', equity: '500', unknown: false, reason: null, marks: [], sessionDate: '2026-09-08', ...over }),
    restriction: (code, action = 'LATCH', over = {}) => ev('RESTRICTION', { code, action, scope: null, source: 'test', sessionDate: '2026-09-08', reason: null, ownerRef: null, ts: clock.now(), ...over }),
    flow: (flowId, direction, amount, over = {}) => ev('EXTERNAL_FLOW_ADMITTED', { flowId, direction, asset: 'USD', amount, valuedUsd: amount, conversionSource: 'USD_IDENTITY', ownerRef: 'owner-test', ts: clock.now(), ...over }),
    mode: (from, to, over = {}) => ev('MODE_TRANSITION', { from, to, reason: 'test', authorizationId: null, ts: clock.now(), ...over }),
    authorized: (authorizationId, over = {}) => ev('ACCOUNT_AUTHORIZED', { authorizationId, kind: 'LIVE_ARM', releaseDigest: HEX('f'), policyDigest: POLICY_DIGEST, codeDigest: HEX('c'), allocationCeiling: '500', reinvestment: 'NONE', limits: SAMPLE_LIMITS, keyFingerprint: 'kf-abc', ownerRef: 'owner-test', issuedTs: clock.now(), expiresTs: clock.now() + 3_600_000, restrictionRevision: 1, canary: null, ...over }),
  };
  return F;
}
// a memory journal with an initialized PAPER account and an acquired writer
export async function paperAccount({ accountId = 'paper-test', clock = fakeClock(), init = {} } = {}) {
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: init.accountKind ?? 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  let revision = 0; const append = async (events) => { const r = await journal.append(accountId, { expectedRevision: revision, writerEpoch: writer.epoch, events: Array.isArray(events) ? events : [events] }); revision = r.revision; return r; };
  await append(F.init(init));
  return { journal, writer, F, clock, accountId, append, revision: () => revision, state: async () => (await journal.load(accountId)).state };
}
export const digest = digestOf;
// closeout R14 fixture completion: a COMPLETED, reconciled canary on a LIVE account (one bounded CANARY_ENTRY filled and
// closed, then AUTHORIZATION_ENDED COMPLETED) — the durable evidence the ordinary LIVE_ARM authorization requires
// (P&L-neutral: equal prices, zero fees, so accounting assertions of the surrounding test are untouched)
export const canaryAuthorization = (F, { authorizationId = 'canary-0', releaseDigest = HEX('f'), pair = 'XBT/USD', codeDigest = HEX('c'), keyFingerprint = 'kf-abc', policyDigest = POLICY_DIGEST } = {}) => F.authorized(authorizationId, { kind: 'CANARY', releaseDigest, codeDigest, keyFingerprint, policyDigest, allocationCeiling: '25', canary: { pair, maxBuyConsiderationWithFees: '25', maxDurationMs: 600_000, lossAcknowledged: true } });
export function canaryCompleted(F, clock, opts = {}) { const { authorizationId = 'canary-0' } = opts; return [canaryAuthorization(F, opts), F.mode('LIVE_UNARMED', 'LIVE_ARMED', { authorizationId }), ...canaryEntryCycle(F, clock, opts), F.ev('AUTHORIZATION_ENDED', { authorizationId, reason: 'COMPLETED', ts: clock.now() }), F.mode('REDUCE_ONLY', 'LIVE_UNARMED', { reason: 'canary completed' })]; }
// one bounded canary entry, filled and closed flat (the entry / exit of the canary itself)
export function canaryEntryCycle(F, clock, { authorizationId = 'canary-0', pair = 'XBT/USD' } = {}) {
  const c = `${authorizationId}-`;
  return [
    F.hypothesis(`${c}d`, { pair }), F.decision(`${c}d`, { pair, sizing: { q: '0.0001', entryLimitPrice: '100000', entryCashOut: '10.08', riskUsd: '1', bufferedScenarioNetProfit: '0.1' } }),
    F.reserve(`${c}r`, `${c}d`, { pair, cashReserved: '10.08', riskReserved: '1' }), F.position(`${c}p`, `${c}d`, { pair, requestedQty: '0.0001' }), F.ev('FEED_PIN', { symbol: pair, action: 'PIN', reason: `canary shell ${c}p`, ts: clock.now() }),
    F.intent(`${c}o`, `${c}p`, `${c}r`, { kind: 'CANARY_ENTRY', pair, qty: '0.0001' }), F.attempt(`${c}o`), F.result(`${c}o`, 'ACKNOWLEDGED'), F.fill(`${c}o`, `${c}x1`, { base: '0.0001', quote: '10', fee: { asset: 'USD', amount: '0' } }),
    F.orderState(`${c}o`, 'FILLED', { nativeOrderId: `nat-${c}o`, nativeCumQty: '0.0001' }), F.release(`${c}r`, { reason: 'ORDER_TERMINAL', releasedCash: '0', releasedRisk: '0' }),
    F.sellIntent(`${c}s`, `${c}p`, { pair, qty: '0.0001', limitPrice: '100000' }), F.attempt(`${c}s`), F.result(`${c}s`, 'ACKNOWLEDGED'), F.fill(`${c}s`, `${c}x2`, { side: 'sell', base: '0.0001', quote: '10', price: '100000', fee: { asset: 'USD', amount: '0' } }), F.orderState(`${c}s`, 'FILLED', { nativeOrderId: `nat-${c}s`, nativeCumQty: '0.0001' }),
    F.closed(`${c}p`, 'FLAT', { residualBase: '0' }),
  ];
}

// focused completion §6 / holdout truth closeout: a REAL holdout chain for release fixtures — the corrected production lifecycle (declare ->
// stage-scoped development / validation looks -> selection lock inside the declared deadline -> one-shot opening -> a bound holdout look)
// run over the memory experiment store with explicit clocks and minimal SEALED reports built through the engine's own identity functions
// (arm bindings, account ids, bundle binding, report digest); nothing here is hand-flagged: the chain is projected from the records it
// created and is bound to the candidate identities the caller names (policy / code / strategy / account)
export function syntheticReport({ declaration, arms, episodes = {}, evidenceScope = null, holdoutOpening = null, replay, bundleDigest = digestOf('fixture-bundle') }) {
  const b = declaration.binding; const boundary = evidenceScope ? evidenceScope.boundaryTs : Infinity; const out = { arms: {} };
  for (const arm of arms) { const binding = replay.armBinding({ experimentId: declaration.experimentId, arm, policyDigest: b.policyDigest, codeDigest: b.codeDigest, strategyVersion: b.strategyVersion, sourcePrefix: b.sourceBinding.sourcePrefix, seed: b.seed }); const eps = (episodes[arm] ?? []).filter((e) => e.ts < boundary);
    const positions = eps.map((e) => ({ positionId: `pos-${e.episodeId}`, decisionId: e.decisionId, assetId: 'BTC', pair: 'XBT/USD', state: 'FLAT', realizedPnl: e.pnl, firstFillTs: e.ts + 500, lastEconomicTs: e.ts + 600_000, exitReason: 'PLANNED_TARGET' }));
    out.arms[arm] = { arm, kind: 'FUNDED', accountId: replay.armAccountId(binding), binding, outcome: 'SCORED', reason: null, closedNetPnl: positions.length ? M.sum(positions.map((p) => p.realizedPnl)) : '0', decisions: eps.map((e) => ({ decisionId: e.decisionId, episodeId: e.episodeId, setupId: 'RANGE_IGNITION', status: 'ENTRY_RESERVED', reasonCodes: [], decisionKnownAtTs: e.ts, triggerTs: e.ts - 2000, inputMode: 'MARKET_DIRECT', caseRefs: null, dependencies: { caseId: null, catalystId: null, sourceId: null } })), positions, headDigest: digestOf({ arm, eps: eps.map((e) => e.episodeId) }), revision: eps.length, depletionDigest: digestOf({ arm, depletion: eps.length }) }; }
  const report = { ok: true, outcome: evidenceScope ? 'COMPLETE_THROUGH_SCOPE' : 'COMPLETE', engine: replay.REPLAY_ENGINE_VERSION, codeIdentity: 'KNOWN', bundleVersion: 'judge-experiment-bundle-1', tieOrderVersion: 'judge-replay-tie-order-1', tieOrderLaw: replay.TIE_ORDER_LAW, experimentId: declaration.experimentId, seed: b.seed, policyDigest: b.policyDigest, codeDigest: b.codeDigest, strategyVersion: b.strategyVersion, sourcePrefix: b.sourceBinding.sourcePrefix, bundleBinding: { experimentId: null, policyDigest: b.policyDigest, codeDigest: b.codeDigest, strategyVersion: b.strategyVersion, sourcePrefix: b.sourceBinding.sourcePrefix, seed: b.seed }, evidenceScope: evidenceScope ? { stage: evidenceScope.stage, boundaryTs: evidenceScope.boundaryTs, lastAppliedSeq: 3, lastAppliedReceiptTs: evidenceScope.boundaryTs - 1, recordsBeyond: 1 } : null, holdoutOpening, bundle: { dir: 'fixture', digest: bundleDigest, sealedLastSeq: 4, records: evidenceScope ? 3 : 4, recordsBeyond: evidenceScope ? 1 : 0, counts: {}, firstTs: declaration.windows.startTs, lastTs: declaration.windows.endTs, lastSeq: evidenceScope ? 3 : 4, clockBackwards: 0, capabilities: {} }, arms: out.arms, observation: {}, stoppedAtSeq: null, fatal: null, law: 'synthetic sealed fixture report', reportDigest: null };
  report.reportDigest = replay.reportDigestOf(report); return report;
}
export async function holdoutChainFixture({ experimentId = 'exp-fixture-chain', policyDigest = 'a'.repeat(64), codeDigest = 'c'.repeat(64), strategyVersion = 'judge-strategy-paper-reference-1', accountId = 'fixture', seed = 'paper-reference-seed-2026-09-08', arm = 'REF_COMBINED', nowTs = T0, store = null } = {}) {
  const X = await import('../../judge/experiment.js'); const replay = await import('../../judge/experiment-replay.js'); const { createMemoryExperimentStore } = await import('../../judge/experiment-store.js'); const st = store ?? createMemoryExperimentStore();
  const day = 86_400_000; const horizons = { lookbackMs: 3_600_000, decisionMs: 0, maxOutcomeMs: 4 * 3_600_000, publicationFloorMs: 0 }; const startTs = nowTs + 60_000; const durationMs = 6 * day; const arms = arm === 'CASH' ? ['REF_COMBINED', 'CASH'] : [arm, 'CASH'];
  const declaration = X.declareExperiment({ experimentId, policyDigest, codeDigest, strategyVersion, arms, seed, sourceBinding: { sourcePrefix: `journal:${accountId}`, accountId }, startTs, durationMs, fractions: { developmentFraction: 0.5, validationFraction: 0.25 }, embargoMs: 0, horizons, nowTs }); await X.persistDeclaration(st, declaration);
  const w = declaration.windows; const ep = (id, ts, pnl) => ({ episodeId: id, decisionId: `dec-${id}`, ts, pnl }); const episodes = { [arm]: [ep('ep-dev-1', w.startTs + day, '3.5'), ep('ep-val-1', w.developmentEndTs + day / 2, '1.25'), ep('ep-hold-1', w.validationEndTs + day / 2, '2')] };
  const look = async (split, boundaryTs, nowTs2) => { const report = syntheticReport({ declaration, arms, episodes, evidenceScope: { stage: split, boundaryTs }, replay }); const assignment = X.assignGroups(declaration, X.groupsFromReport(report, declaration), { nowTs: nowTs2 }); await X.persistEvaluation(st, experimentId, X.evaluateSplit({ declaration, assignment, report, split, nowTs: nowTs2 })); };
  await look('DEVELOPMENT', w.developmentEndTs, w.developmentEndTs + 1); await look('VALIDATION', w.validationEndTs, w.validationEndTs + 1); await X.lockCandidate(st, { experimentId, arm, nowTs: w.validationEndTs + 2 });
  const after = w.endTs + horizons.maxOutcomeMs + 1000; const { opening } = await X.openHoldout(st, { experimentId, runId: 'run-fixture-1', nowTs: after }); const bound = syntheticReport({ declaration, arms, episodes, holdoutOpening: opening.digest, replay }); await X.evaluateHoldout(st, { experimentId, runId: 'run-fixture-1', report: bound, nowTs: after + 1 });
  const chain = await X.holdoutChain(st, experimentId); return Object.assign(chain, { __store: st });
}
