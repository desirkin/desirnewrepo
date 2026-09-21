// JUDGE — the sole strategy decision producer (ticket §2.1, §4-6). Deterministic versioned setup rules over facts, with
// validated Socrates interpretation only where a setup consumes it; NO LLM call, no model per tick / stop / fill. Every
// accepted trade / book updates the cheap coverage / trigger / persistence state; expensive evaluation is coalesced through
// the 25ms scheduler; the price-blind law commits HYPOTHESIS_LOCKED at the frozen trigger T BEFORE any execution
// valuation; the decision envelope, reservation, position shell, feed pin and durable ORDER_INTENT commit in ONE account
// transaction with a revision recheck; the dispatcher then sends through the outbox. Entry permission is the intersection
// of authenticated controls, account mode / release, risk and health. NO_TRADE is a successful decision.
import * as M from '../execution/money.js';
import { indicatorBlock, createFlowTracker, createFeatureCache, bookFacts, bidDepthWithinBps, medianDecimal, minDecimal, validateBarBlock, FEATURE_VERSION, FI_MIN_TRADES } from './features.js';
import { SETUPS, SETUP_INPUT_MODES, REFERENCE, freezeReferences, evaluateSetup, evaluateStyleExecutionGate, createConfirmation, createEpisodeTracker, hypothesisDigest, setupDefinition, STRATEGY_VERSION, LEARNABLE_GATES, learnedOverrides } from './setups.js'; // PUBLISH-FIX-82: the learnable gate lines
import { evaluateEntry, sizeSearch, liquidationValue, COST_MODEL_VERSION } from './cost.js';
import { admitCandidate, riskBudgetFor, rankCandidates, clusterIdOf } from './risk.js';
import { makeDecision, decisionIdentity, decisionRecord } from './contract.js';
import { intakeDecision, consumeCase, primaryConfirmedCatalyst } from './intake.js';
import { JUDGE_FACT_RECIPE_VERSION, resolveLearningContribution, contributionMeasurement, contributionCandidateLog, learnedFactMeasurements } from './learning-intake.js';
import { evaluateSizeLadder, sizingMeasurement, sizingCandidateLog } from './size-ladder.js';
import { SETUP_SELECTION_VERSION, createUnderlyingClaimLedger, deterministicSetupTieOrder, selectionMeasurement, setupDurationBound, strategyFamilyOf } from './setup-selection.js';
import { EDGE_POLICY_VERSION, EDGE_STATE_VERSION, EDGE_WATCH_VERSION, OPERATIONAL_EDGE_STRATEGY_VERSION, deriveOperationalEntryFacts, edgePositionManagement, edgeStatePortError, executableEdgeFromEvaluation, isEdgeSetup } from './edge-state.js';
import { createScheduler } from './scheduler.js';
import { judgeReadinessMatrix } from './readiness.js';
import { entryBlockingRestrictions } from '../execution/reducer.js';
import { entryPermission } from '../execution/authority.js';
import { d1Feature, d2Feature, d3Feature, transferAnomaly, peerMembership } from './challengers.js';
import { VERDICT_WORDS, digestOf } from '../execution/contract.js';
import {
  ADAPTIVE_RANKING_MEASUREMENT_ID, ADAPTIVE_RANKING_PORT_VERSION,
  ADAPTIVE_RANKING_UNITS, adaptiveRankingInputCaptureError,
  adaptiveRankingPortResultError,
} from './adaptive-ranking-port.js';
import { moveClockFacts, moveClockVerdict, moveClockMeasurements, MOVE_CLOCK_BARS } from './move-clock.js'; // PUBLISH-FIX-73: the move clock (port-gated; absent -> baseline)
export const VERDICT_RECORD_VERSION = 'judge-challenger-verdict-1';

export const JUDGE_VERSION = 'judge-1';
export const ADAPTIVE_RANKING_HOOK_VERSION = 'judge-adaptive-ranking-hook-1';
const PERSISTENCE_PERMISSION_REASON = 'PERSISTENCE_PERMISSION_LOCK';
const ownDataProperty = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
// a CANARY authorization bounds the position duration (closeout R14): the shorter of the policy duration and the owner's canary bound
export const canaryDurationBound = (s, policyMs) => { const a = s?.authorization; const bound = a && !a.ended && a.kind === 'CANARY' && Number.isSafeInteger(a.canary?.maxDurationMs) ? a.canary.maxDurationMs : null; return bound === null ? policyMs : Math.min(policyMs, bound); };
export const FUNNEL_STAGES = Object.freeze(['discovered', 'recorded', 'warmed', 'nominated', 'setupQualified', 'costQualifiedAtLegalSize', 'reserved', 'sent', 'filled', 'protected', 'closedReconciled']);
const inc = (obj, k, n = 1) => { obj[k] = (obj[k] ?? 0) + n; };

export function createJudge({ accountId, policy, policyDigest, dispatcher, feed, clock, specOf, feeOf, history = { bars: () => null }, caseSource = { consumed: () => null }, controls = () => ({ kill: false, cage: false, vetoes: [] }), lockLevel = () => 'NONE', clusters = () => null, log = () => {}, scheduler = null, enabledSetups = null, mode = 'PAPER', snapshotStore = null, armRule = null, verdictSink = null, learning = null, dynamicSizing = null, setupSelection = null, edgeState = null, permissionIncreaseAllowed = null, adaptiveRanking = null, moveClock = null, secondLook = null, gateLearning = null }) {
  // LEARN-1 consumer seam (ADDENDUM-2 §08): `learning` is an OPTIONAL injected read accessor over the prepared
  // immutable decision-memory snapshot ({ snapshot: () => readDecisionMemory(...) }), refreshed outside this loop.
  // Absent (every current composition; fly.js passes nothing), every path below is byte-identical to the baseline
  // Judge. Present, its ONLY effect is a bounded rank-order nudge among ALREADY fully qualified candidates plus a
  // measurement row recording what was consumed or why nothing was — never sizing, risk, permission, case intake,
  // The Watch, or any committed event payload.
  // DYNAMIC SIZING seam (final sizing addendum): `dynamicSizing` is the SECOND independent default-off switch
  // ({ fractions? }). Absent, sizing is the exact existing sizeSearch call. Present, the size ladder evaluates
  // multiple fractions of the SAME risk-bounded spendable budget through the SAME cost law and records every
  // candidate size; risk caps, admission, permission and The Watch are untouched at every size.
  // armRule (focused completion §5): a research-only experiment arm — enabled setups, a named clause ablation, a deterministic nomination
  // thinning and the challengers whose verdicts gate admission. PAPER / LIVE compositions never pass one; a REPLAY arm is one account.
  if (armRule && mode !== 'REPLAY') throw new Error('an arm rule is research configuration: only a REPLAY composition may carry one');
  // Strategy-family selection is a separate, explicit version transition. The
  // default path remains the exact legacy four-setup Judge. Fail closed on any
  // malformed/future port instead of treating a truthy object as authority.
  const selectionKeys = setupSelection === null ? [] : (setupSelection && typeof setupSelection === 'object' && !Array.isArray(setupSelection) ? Object.keys(setupSelection) : []);
  if (setupSelection !== null && (selectionKeys.length !== 1 || selectionKeys[0] !== 'version' || setupSelection.version !== SETUP_SELECTION_VERSION)) throw new Error(`invalid setupSelection port; expected { version: '${SETUP_SELECTION_VERSION}' }`);
  const hookKeys = adaptiveRanking === null ? [] : (adaptiveRanking && typeof adaptiveRanking === 'object' && !Array.isArray(adaptiveRanking) ? Reflect.ownKeys(adaptiveRanking) : []);
  const adaptivePort = ownDataProperty(adaptiveRanking, 'port');
  const adaptivePreparedInputAt = ownDataProperty(adaptiveRanking, 'preparedInputAt');
  const hookVersion = ownDataProperty(adaptiveRanking, 'version');
  const portKeys = adaptivePort && typeof adaptivePort === 'object' && !Array.isArray(adaptivePort) ? Reflect.ownKeys(adaptivePort) : [];
  const adaptiveHookConfigured = hookKeys.length === 3
    && hookKeys.every((key) => typeof key === 'string' && ['version', 'port', 'preparedInputAt'].includes(key))
    && hookVersion === ADAPTIVE_RANKING_HOOK_VERSION
    && portKeys.length === 2
    && portKeys.every((key) => typeof key === 'string' && ['version', 'resolve'].includes(key))
    && ownDataProperty(adaptivePort, 'version') === ADAPTIVE_RANKING_PORT_VERSION
    && typeof ownDataProperty(adaptivePort, 'resolve') === 'function'
    && typeof adaptivePreparedInputAt === 'function';
  const setupSelectionEnabled = setupSelection !== null;
  if (edgeState !== null && edgeStatePortError(edgeState)) throw new Error(`invalid edgeState port; expected { version: '${EDGE_STATE_VERSION}' }`);
  const edgeStateEnabled = edgeState !== null;
  const decisionStrategyVersion = policy.strategyVersion ?? STRATEGY_VERSION;
  const operationalEdgePolicy = policy?.policyVersion === EDGE_POLICY_VERSION
    && policy?.strategyVersion === OPERATIONAL_EDGE_STRATEGY_VERSION
    && policy?.watchVersion === EDGE_WATCH_VERSION
    && policy?.setups?.selectionVersion === SETUP_SELECTION_VERSION
    && policy?.setups?.edgeStateVersion === EDGE_STATE_VERSION;
  const keepSnapshots = Boolean(armRule?.challengers?.length);
  const S = scheduler ?? createScheduler({ monotonic: () => clock.monotonic() }); const setups = armRule?.setups ?? enabledSetups ?? policy.setups.enabled;
  // EDGE_STATE setups are research evaluators only until both their post-size
  // execution gate and their Watch exit contract are composed. Check the
  // effective list after every override so no caller can accidentally turn a
  // null operational horizon into the generic policy duration.
  for (const setupId of setups) if (setupDefinition(setupId)?.operationalMaxDurationMs === null
      && (!isEdgeSetup(setupId) || !edgeStateEnabled || !setupSelectionEnabled || !operationalEdgePolicy)) {
    throw new Error(`NEW_SETUP_NOT_OPERATIONAL: ${setupId} requires the exact v2 strategy, post-size execution gate, strategy selection, and Watch EDGE_STATE contract`);
  }
  const cache = createFeatureCache({ max: 128 });
  const candidates = new Map(); // symbol -> runtime
  // PUBLISH-FIX-79 (THE SECOND LOOK, 2026-09-19). The gate match-up of 2026-09-19 (807 graded looks): on the winners the Judge refused,
  // the failing clauses were the BUYING-PRESSURE gates (FI15, FI60_POSITIVE, RV60, the absorption priors) — the structure was
  // right and the look came a few minutes EARLY, before the flow showed up. And an episode tracker never re-crosses while the
  // mid stays above the level: a coin that keeps climbing after an early look never gets another. So, with the port composed:
  // a NO_TRADE whose refused clauses are ALL flow gates schedules ONE second look — after `afterMs`, if the coin is still at or
  // above the same level and no episode is pending, the tracker is re-armed and the next book counts as a fresh crossing: new
  // frozen references, new durable lock, new confirmation, EVERY gate again at full strength. Bounded to `maxLooks` per chain
  // (a natural crossing starts a new chain); a mid below the level drops the look (the thesis is gone; a natural re-cross will
  // come). No threshold moves. Port absent: nothing here runs and the record is the baseline byte for byte.
  // PUBLISH-FIX-101 (2026-09-21): the second look had NEVER armed once in the app's life — `flow-only refusals 0` on every funnel line
  // ever printed. It was not tuning: the arming test requires EVERY refused gate to be in this set, and two gates that are pure
  // right-now flow were missing from it, so they ended the chain on almost every look that the feature exists for.
  //   FI15_FRESH_AT_D — the SAME 15-second buying-pressure measure as FI15, read at the decision instant (judge/setups.js line 137);
  //     it was already trusted as retryable in DATA_LOOK_GATES below. Live companion count over four days: 2,307 — the single most
  //     common reason a flow refusal was thrown away.
  //   DEPTH_HOLDS_80PCT_OF_BASELINE — the CURRENT 10bps bid notional against the frozen median; a book fact about this second,
  //     not about the coin. Companion count: 1,173.
  // Everything structural still ends the chain exactly as before: trend (EMA5_ABOVE_EMA20), phase (CONTINUATION_PHASE_ELIGIBLE,
  // NOT_EXHAUSTED), evidence (DISTINCT_EVIDENCE_DIMENSIONS), geometry (PULLBACK_WITHIN_1_5_ATR, COMPRESSION_5BAR, STOP_GEOMETRY).
  // No threshold moves, no gate is skipped: a second look is a fresh crossing judged by every gate at full strength.
  const SECOND_LOOK_FLOW_GATES = new Set(['FI15', 'FI60_POSITIVE', 'RV60', 'PRIOR_FI_ABSORBED', 'PRIOR_MID_RESPONSE_SMALL', 'RECLAIM_FI15', 'FI15_FRESH_AT_D', 'DEPTH_HOLDS_80PCT_OF_BASELINE']);
  // PUBLISH-FIX-82 GATE LEARNING (owner directive 2026-09-19): a port whose lesson() answers the learned lines { FI15: 0.15, ... }
  // for judge/setups.js LEARNABLE_GATES; each decision reads the lesson ONCE (so one look is judged on one set of lines), only
  // finite numbers inside a gate's band count, a faulting port reads as absent, and the decision carries a GATE_LEARNING row
  // naming every line that differs from its reference. Port absent -> REFERENCE lines, the record byte for byte as before.
  const gateLearningPort = gateLearning && typeof gateLearning === 'object' && typeof gateLearning.lesson === 'function' ? gateLearning : null;
  function learnedLinesNow(setupId) {
    if (!gateLearningPort) return null;
    let raw = null; try { raw = gateLearningPort.lesson(setupId); } catch (err) { log(`gate learning port failed (reference lines for this decision): ${String(err?.message ?? err).slice(0, 160)}`); return null; }
    const lines = raw && typeof raw === 'object' && raw.lines && typeof raw.lines === 'object' ? raw.lines : raw;
    if (!lines || typeof lines !== 'object') return null;
    const out = {}; for (const id of Object.keys(LEARNABLE_GATES)) { const v = lines[id]; if (typeof v === 'number' && Number.isFinite(v) && v >= LEARNABLE_GATES[id].min && v <= LEARNABLE_GATES[id].max) out[id] = v; }
    return Object.keys(out).length ? out : null;
  }
  function gateLearningMeasurement(learned, setupId) {
    if (!gateLearningPort || !learned) return [];
    const moved = learnedOverrides(learned, setupId); if (!moved.length) return [];
    return [{ id: 'GATE_LEARNING', ok: true, value: moved.length, threshold: null, unit: 'COUNT', note: `learned lines in force: ${moved.map((m) => `${m.id} ${m.reference}->${m.line}`).join(', ')}`.slice(0, 200), class: 'MEASUREMENT', ablated: false }];
  }
  const secondLookCfg = secondLook && typeof secondLook === 'object' ? { afterMs: Number.isFinite(secondLook.afterMs) && secondLook.afterMs >= 15_000 ? secondLook.afterMs : 180_000, maxLooks: Number.isInteger(secondLook.maxLooks) && secondLook.maxLooks >= 1 ? Math.min(secondLook.maxLooks, 4) : 2, staleMs: 120_000 } : null;
  function scheduleSecondLook(c, setupId, frozen, refused, D) {
    if (!secondLookCfg) return;
    if (!frozen || !Array.isArray(refused) || !refused.length || !refused.every((id) => SECOND_LOOK_FLOW_GATES.has(id))) {
      // PUBLISH-FIX-101: a chain that ends SAYS WHICH GATE ENDED IT. Silence here is what hid a dead feature for four days: the
      // counter read 0 and nothing named the gate doing the killing. Bounded to 32 names; flow-only refusals are never counted here.
      if (Array.isArray(refused) && refused.length && refused.some((id) => SECOND_LOOK_FLOW_GATES.has(id))) {
        counters.secondLookEndedBy = counters.secondLookEndedBy ?? {};
        for (const id of refused) if (!SECOND_LOOK_FLOW_GATES.has(id) && (counters.secondLookEndedBy[id] !== undefined || Object.keys(counters.secondLookEndedBy).length < 32)) counters.secondLookEndedBy[id] = (counters.secondLookEndedBy[id] ?? 0) + 1;
      }
      if (c.secondLook.delete(setupId)) counters.secondLooksEnded = (counters.secondLooksEnded ?? 0) + 1; return;
    } // a structural refusal ends the chain (PUBLISH-FIX-83 item 37: counted)
    counters.flowOnlyRefusals += 1;
    const prev = c.secondLook.get(setupId); const looks = prev ? prev.looks : 0;
    if (looks >= secondLookCfg.maxLooks) { counters.secondLooksDropped += 1; c.secondLook.delete(setupId); return; }
    if (prev) counters.secondLooksReplaced = (counters.secondLooksReplaced ?? 0) + 1;
    c.secondLook.set(setupId, { state: 'WAITING', dueTs: D + secondLookCfg.afterMs, level: frozen.triggerLevel, looks, refused: [...refused], episodeId: null });
  }
  // PUBLISH-FIX-83 (full review item 13): a NEEDS_DATA look (RV60 waiting on 21 minutes of coverage, FI waiting on prints) ended the
  // crossing with no second look at all, so a mover was judged blind exactly once in its first 21 minutes and never again until the
  // mid fell below the level and re-crossed. Now a data-only refusal schedules a second look when the data can be there: at the
  // coverage clock's 21-minute mark for an RV60 coverage wait, else after the ordinary second-look delay; never more than 25 minutes out.
  const DATA_LOOK_GATES = new Set([...SECOND_LOOK_FLOW_GATES, 'COVERAGE_60S']); // PUBLISH-FIX-101: FI15_FRESH_AT_D moved up into the flow set itself
  function scheduleDataLook(c, setupId, frozen, refused, D, fast) {
    if (!secondLookCfg || !frozen || !Array.isArray(refused) || !refused.length || !refused.every((id) => DATA_LOOK_GATES.has(id))) return;
    const prev = c.secondLook.get(setupId); const looks = prev ? prev.looks : 0; if (looks >= secondLookCfg.maxLooks) return;
    let dueTs = D + secondLookCfg.afterMs; const cov = fast?.coverage;
    if (refused.includes('RV60') && fast?.rv60?.reason === 'COVERAGE_INCOMPLETE' && cov?.continuous === true && Number.isSafeInteger(cov.startTs)) dueTs = Math.max(D + 15_000, cov.startTs + 21 * 60_000 + 1000);
    if (dueTs - D > 25 * 60_000) return; counters.dataLooksScheduled = (counters.dataLooksScheduled ?? 0) + 1;
    c.secondLook.set(setupId, { state: 'WAITING', dueTs, level: frozen.triggerLevel, looks, refused: [...refused], episodeId: null, data: true });
  }
  // an INFRASTRUCTURE refusal (the decision queue lagged, no indicators yet, the lock not durable in time) burned the crossing: a
  // new look needed the mid to fall below the level and re-cross. It now re-arms the tracker so the next fresh book at/above the
  // level is a fresh crossing (cooldown, confirmation, lock and every gate apply as always) — bounded to 3 per 5 minutes per setup.
  function rearmAfterInfra(c, setupId, why) {
    const tr = c.episodes[setupId]; if (!tr) return false; const t = now(); const key = `${setupId}`; const rec = c.infraRearms.get(key) ?? { count: 0, sinceTs: t }; if (t - rec.sinceTs > 300_000) { rec.count = 0; rec.sinceTs = t; }
    if (rec.count >= 3) { counters.infraRearmsRefused = (counters.infraRearmsRefused ?? 0) + 1; c.infraRearms.set(key, rec); return false; }
    if (!tr.rearm()) return false; rec.count += 1; c.infraRearms.set(key, rec); counters.infraRearms = (counters.infraRearms ?? 0) + 1; log(`re-armed after an infrastructure refusal: ${c.symbol} ${setupId} (${why}) ${rec.count} of 3 in 5 min`); return true;
  }
  // PUBLISH-FIX-84 (the owner's night, 2026-09-20): a look that passed EVERY gate and died at sizing is the closest he ever comes to a
  // bite, and it left one word in the log (NO_TRADE_SIZE). It now says which number stopped it, in the owner's terms.
  function closeCall(c, setupId, reasons, detail, budget, setup) {
    counters.closeCalls = (counters.closeCalls ?? 0) + 1;
    log(`CLOSE CALL: ${c.symbol} ${setupId} passed every gate; no trade size — ${reasons.join(', ')}${detail.length ? ` [${detail.join(' | ')}]` : ''} (cash ${budget?.cash ?? '?'}, risk budget ${budget?.budget ?? '?'}, target ${setup?.scenario?.target ?? '?'}${setup?.scenario?.cappedBy?.price ? ` capped by the book at ${setup.scenario.cappedBy.price}` : ''})`);
  }
  function secondLookMeasurement(c, setupId, episodeId) {
    const p = secondLookCfg ? c.secondLook.get(setupId) : null; if (!p || p.state !== 'CROSSED' || p.episodeId !== episodeId) return [];
    return [{ id: 'SECOND_LOOK', ok: true, value: p.looks, threshold: secondLookCfg.maxLooks, unit: 'COUNT', note: `look ${p.looks} of ${secondLookCfg.maxLooks} after a ${p.data ? 'data-only' : 'flow-only'} refusal (${p.refused.join(',')}) ${Math.round(secondLookCfg.afterMs / 60_000)} min earlier at the same level`, class: 'MEASUREMENT', ablated: false }];
  }
  // PUBLISH-FIX-83 (full review item 23): the learning bridge used to sample the 256-deep cockpit ring once a minute — any minute with
  // more than 256 decisions, or a delayed tick, lost decisions silently. Every decision is now also queued for the bridge, which
  // DRAINS the queue (takeDecisions); the queue is bounded far above any minute's volume and counts what it ever had to drop.
  const BRIDGE_QUEUE_MAX = 20_000; const BRIDGE_QUEUE_MAX_AGE_MS = 15 * 60_000; const bridgeQueue = []; const offerToBridge = (d) => { bridgeQueue.push(d); if (bridgeQueue.length > BRIDGE_QUEUE_MAX) { bridgeQueue.shift(); counters.bridgeOverflow = (counters.bridgeOverflow ?? 0) + 1; } const t = now(); while (bridgeQueue.length && (t - (bridgeQueue[0].decisionKnownAtTs ?? t)) > BRIDGE_QUEUE_MAX_AGE_MS) { bridgeQueue.shift(); counters.bridgeExpired = (counters.bridgeExpired ?? 0) + 1; } }; // review finding: with no consumer (learning off) the queue is bounded by age, never a 20,000-decision retention
  const funnel = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])); const refusals = {}; const counters = { books: 0, trades: 0, crossings: 0, confirmations: 0, expired: 0, decisions: 0, entries: 0, needsData: 0, missedDuringWarmup: 0, modelWait: 0, modelStale: 0, missedDuringAnalysis: 0, revalidationRefusals: 0, queueDelayExpired: 0, snapshotPersistFailures: 0, staleReoffered: 0, lockWaits: 0, lockReoffered: 0, lockBatches: 0, lockCoalesced: 0, moveTooOld: 0, flowOnlyRefusals: 0, secondLooksArmed: 0, secondLookCrossings: 0, secondLooksDropped: 0 }; const decisions = []; let lastEntryMono = null; const provenance = new Map(); // episode|decision clock -> the already-known dependency identities (research report only)
  const now = () => clock.now(); const state = () => dispatcher.state(); const ev = dispatcher.ev;
  // Persistence integrity can only remove entry authority. Low-level callers
  // that do not inject this seam retain the historical isolated-test law;
  // any supplied non-true value or exception is an explicit fail-closed lock.
  function permissionIncreaseGate() {
    if (permissionIncreaseAllowed === undefined || permissionIncreaseAllowed === null) return { ok: true, reason: null };
    try {
      const observed = typeof permissionIncreaseAllowed === 'function' ? permissionIncreaseAllowed() : undefined;
      if (observed !== null && (typeof observed === 'object' || typeof observed === 'function') && typeof observed.then === 'function') { Promise.resolve(observed).catch(() => {}); return { ok: false, reason: PERSISTENCE_PERMISSION_REASON }; }
      return observed === true ? { ok: true, reason: null } : { ok: false, reason: PERSISTENCE_PERMISSION_REASON };
    }
    catch { return { ok: false, reason: PERSISTENCE_PERMISSION_REASON }; }
  }
  const adaptiveNoEffect = (reason, baseline) => Object.freeze({
    applied: false, effectiveRewardRiskRatio: baseline,
    measurement: Object.freeze({
      id: ADAPTIVE_RANKING_MEASUREMENT_ID, ok: false, value: null, threshold: null,
      unit: ADAPTIVE_RANKING_UNITS,
      note: `${ADAPTIVE_RANKING_HOOK_VERSION}:${reason}:NO_EVIDENCE`.slice(0, 300),
    }),
  });
  function resolveAdaptiveRanking({ c, setupId, D, snap, evaluation }) {
    if (adaptiveRanking === null) return null;
    const baseline = Number(evaluation.rewardRiskRatio);
    if (!adaptiveHookConfigured) return adaptiveNoEffect('HOOK_CONTRACT_INVALID', baseline);
    const context = Object.freeze({ setupType: setupId, regime: 'LIVE_UNCLASSIFIED', asset: c.assetId, venue: c.spec.venue });
    const query = Object.freeze({
      decisionTs: D, context, strategyId: setupId, pair: c.symbol,
      specDigest: c.spec.specDigest, bookSnapshotDigest: snap.digest,
    });
    let prepared;
    try { prepared = adaptivePreparedInputAt(query); }
    catch { return adaptiveNoEffect('PRE_DECISION_INPUT_READER_FAILED', baseline); }
    try {
      if (prepared instanceof Promise) {
        Promise.resolve(prepared).catch(() => {});
        return adaptiveNoEffect('PRE_DECISION_INPUT_ASYNC_REFUSED', baseline);
      }
    } catch { return adaptiveNoEffect('PRE_DECISION_INPUT_INVALID', baseline); }
    if (prepared === null || prepared === undefined) return adaptiveNoEffect('PRE_DECISION_INPUT_UNAVAILABLE', baseline);
    const keys = prepared && typeof prepared === 'object' && !Array.isArray(prepared) ? Reflect.ownKeys(prepared) : [];
    if (keys.length !== 4 || keys.some((key) => typeof key !== 'string'
        || !['snapshot', 'factsEnvelope', 'consumerContract', 'captureReceipt'].includes(key))) {
      return adaptiveNoEffect('PRE_DECISION_INPUT_INVALID', baseline);
    }
    const snapshot = ownDataProperty(prepared, 'snapshot');
    const factsEnvelope = ownDataProperty(prepared, 'factsEnvelope');
    const consumerContract = ownDataProperty(prepared, 'consumerContract');
    const captureReceipt = ownDataProperty(prepared, 'captureReceipt');
    if ([snapshot, factsEnvelope, consumerContract, captureReceipt].some((value) => value === undefined)) {
      return adaptiveNoEffect('PRE_DECISION_INPUT_INVALID', baseline);
    }
    const input = {
      snapshot, factsEnvelope, consumerContract, context, strategyId: setupId,
      postCostEvaluation: evaluation, mode, decisionTs: D,
    };
    let captureError;
    try { captureError = adaptiveRankingInputCaptureError(captureReceipt, input); }
    catch { captureError = 'CAPTURE_VALIDATION_FAILED'; }
    if (captureError) {
      return adaptiveNoEffect('PRE_DECISION_DURABLE_CAPTURE_INVALID', baseline);
    }
    let result;
    try { result = ownDataProperty(adaptivePort, 'resolve')(input); }
    catch { return adaptiveNoEffect('PORT_RESOLVER_FAILED', baseline); }
    try {
      if (result instanceof Promise) {
        Promise.resolve(result).catch(() => {});
        return adaptiveNoEffect('PORT_ASYNC_REFUSED', baseline);
      }
    } catch { return adaptiveNoEffect('PORT_RESULT_INVALID', baseline); }
    try {
      if (adaptiveRankingPortResultError(result)
          || result.strategyId !== setupId
          || result.baselineRewardRiskRatio !== baseline
          || result.effectiveRewardRiskRatio !== (result.applied
            ? Number((baseline + result.adjustmentRrPoints).toFixed(9)) : baseline)
          || (result.evidence !== null && (
            result.evidence.decisionTs !== D
            || result.evidence.strategyId !== setupId
            || result.evidence.context?.asset !== c.assetId
            || result.evidence.context?.venue !== c.spec.venue
            || result.evidence.sourceDigest !== factsEnvelope.sourceBinding?.sourceDigest
            || result.evidence.consumerContractDigest !== consumerContract.consumerContractDigest
            || result.evidence.costEvaluationDigest !== digestOf(evaluation)
            || result.evidence.specDigest !== c.spec.specDigest
            || result.evidence.snapshotDigest !== snap.digest
          ))) return adaptiveNoEffect('PORT_RESULT_INVALID', baseline);
    } catch { return adaptiveNoEffect('PORT_RESULT_INVALID', baseline); }
    return Object.freeze({
      applied: result.applied,
      effectiveRewardRiskRatio: result.effectiveRewardRiskRatio,
      measurement: result.measurement,
    });
  }
  // deterministic ranking BEFORE reservation (closeout R08): every candidate that reaches the admission point inside one scheduler
  // pass registers here; the batch is ranked (rankCandidates: reward / stressed risk, cost bps, first known, asset) and admitted ONE
  // at a time in that order, each seeing the reservations the earlier ones committed — receipt order never decides
  const gate = { pending: [], scheduled: false, batches: 0, lastBatch: null };
  function admissionGate(entry) { return new Promise((resolve) => { gate.pending.push({ ...entry, resolve }); if (!gate.scheduled) { gate.scheduled = true; setImmediate(() => flushGate().catch((err) => log(`admission gate: ${err.message}`))); } }); }
  async function flushGate() {
    const batch = gate.pending; gate.pending = []; gate.scheduled = false; if (!batch.length) return;
    gate.batches += 1;
    if (!setupSelectionEnabled) {
      const ranked = rankCandidates(batch.map((b) => ({ ...b.rank, entry: b })));
      const unranked = batch.filter((b) => !ranked.some((r) => r.entry === b));
      const order = [...ranked.map((r) => r.entry), ...unranked];
      const batchReport = { size: batch.length, order: order.map((b) => b.rank.assetId) };
      gate.lastBatch = batchReport;
      for (let i = 0; i < order.length; i += 1) await new Promise((done) => order[i].resolve({ rank: i + 1, of: order.length, done }));
      return;
    }
    // The existing risk rank remains primary. The pre-order contributes only
    // the deterministic family/setup tie which risk.js otherwise leaves equal
    // for two setups of the same asset.
    const tied = deterministicSetupTieOrder(batch);
    const ranked = rankCandidates(tied.map((b) => ({ ...b.rank, entry: b })));
    const unranked = tied.filter((b) => !ranked.some((r) => r.entry === b));
    const order = [...ranked.map((r) => r.entry), ...unranked];
    const claims = createUnderlyingClaimLedger(); const outcomes = [];
    const batchReport = { size: batch.length, order: order.map((b) => b.rank.assetId), detail: order.map((b) => ({ assetId: b.rank.assetId, setupId: b.rank.setupId, family: strategyFamilyOf(b.rank.setupId) })) };
    gate.lastBatch = batchReport;
    for (let i = 0; i < order.length; i += 1) {
      const entry = order[i]; const offered = claims.offer({ assetId: entry.rank.assetId, setupId: entry.rank.setupId });
      if (!offered.selected) {
        outcomes.push({ assetId: entry.rank.assetId, setupId: entry.rank.setupId, outcome: 'NOT_SELECTED', winnerSetupId: offered.winnerSetupId });
        entry.resolve({ rank: i + 1, of: order.length, selected: false, winnerSetupId: offered.winnerSetupId, done: () => {} });
        continue;
      }
      const result = await new Promise((done) => entry.resolve({ rank: i + 1, of: order.length, selected: true, winnerSetupId: null, done }));
      const didClaim = result?.claimed === true;
      outcomes.push({ assetId: entry.rank.assetId, setupId: entry.rank.setupId, outcome: didClaim ? 'CLAIMED' : 'FALLBACK_ALLOWED', winnerSetupId: null });
      claims.settle({ assetId: entry.rank.assetId, setupId: entry.rank.setupId, claimed: didClaim });
    }
    // Capture the batch object before any await: a later batch may replace
    // gate.lastBatch while this one is still settling.
    batchReport.outcomes = outcomes;
  }
  function admit(symbol, { assetId = symbol.split('/')[0], priority = 'CANDIDATE', nominationKnownAtTs = now(), source = 'MANUAL' } = {}) {
    if (candidates.has(symbol)) return candidates.get(symbol); const spec = specOf(symbol); if (!spec) { inc(refusals, 'INSTRUMENT_SPEC_UNKNOWN'); return null; }
    if (policy.universe.excludeBases.includes(assetId)) { inc(refusals, 'EXCLUDED_BASE'); return null; } if (spec.status !== 'online') { inc(refusals, `INSTRUMENT_${spec.status.toUpperCase()}`); return null; }
    const fa = feed ? feed.admit(symbol, { coin: assetId, priority, reason: source, specDigest: spec.specDigest }) : { ok: true }; if (!fa.ok) { inc(refusals, `FEED_${fa.reason}`); return null; }
    // PUBLISH-FIX-83 (full review item 15): a nomination the tape does not carry (its subscription was refused NOT_IN_TAPE_UNIVERSE) would take a
    // preparation slot with no books for up to an hour; it is refused here instead, and the feed admission it just made is released
    if (fa.subscription && fa.subscription.ok === false && fa.subscription.reason === 'NOT_IN_TAPE_UNIVERSE' && !fa.existing) { inc(refusals, 'FEED_NOT_IN_TAPE_UNIVERSE'); counters.blindNominationsRefused = (counters.blindNominationsRefused ?? 0) + 1; try { feed.release(symbol); } catch { /* nothing to release */ } return null; }
    const c = { symbol, assetId, spec, priority, source, nominationKnownAtTs, admittedTs: now(), flow: createFlowTracker({ retentionMs: 25 * 60_000 }), books: [], snapshots: [], lastBook: null, indicators: null, indicatorsRef: null, episodes: Object.fromEntries(setups.map((s) => [s, createEpisodeTracker({ assetId, setupId: s, cooldownMs: policy.execution.cooldownMs })])), confirmations: new Map(), frozen: new Map(), readiness: null, decisionsMade: 0, secondLook: new Map(), infraRearms: new Map() };
    candidates.set(symbol, c); funnel.discovered += 1; funnel.recorded += 1; if (source !== 'MANUAL') funnel.nominated += 1; return c;
  }
  function release(symbol) { const c = candidates.get(symbol); if (!c) return; if (Object.values(state()?.positions ?? {}).some((p) => p.pair === symbol && p.state !== 'FLAT')) return; candidates.delete(symbol); if (feed) feed.release(symbol); }
  // ---- cheap per-message state --------------------------------------------------------------------------------------------
  function refreshIndicators(c, nowTs) { const bars = history.bars(c.symbol, nowTs); c.lastBars = bars ?? null; if (!bars) { c.indicators = null; c.indicatorsReason = 'NO_HISTORY'; return null; } const v = validateBarBlock(bars, { referenceTs: nowTs }); if (!v.ok) { c.indicators = null; c.indicatorsReason = v.reason; return null; } c.indicatorsReason = null; const { value, hit } = cache.get({ blockDigest: bars.map((b) => `${b.periodStartTs}:${b.close}:${b.high}:${b.low}`).join('|'), referenceTs: bars[bars.length - 1].periodEndTs, featureVersion: FEATURE_VERSION }, () => indicatorBlock(bars)); c.indicators = value; c.indicatorsRef = { hit, bars }; return value; }
  // PUBLISH-FIX-10: the window aggregates (flow windows over the trade tape, the 60 s prior-depth median, the prior
  // mids / lows) are recomputed at most once per FAST_WINDOW_MS per candidate; the per-snapshot facts (mid, best bid/ask,
  // book age, depth, crc, sequence, digest) are recomputed on every tick as before. On Kraken's tick rate the per-tick
  // recomputation of the windows was 100% of the main thread (production profile, boots 954229d8..f566132c).
  const FAST_WINDOW_MS = 250;
  const FI_FLOOR_15 = Object.freeze({ minTrades: FI_MIN_TRADES, maxWindowMs: 60_000 }); const FI_FLOOR_60 = Object.freeze({ minTrades: FI_MIN_TRADES, maxWindowMs: 180_000 });
  function windowFacts(c, decisionTs, cov) {
    const cached = c.windowFacts; if (cached && decisionTs - cached.ts >= 0 && decisionTs - cached.ts < FAST_WINDOW_MS && cached.epoch === (cov?.epoch ?? null)) return cached.value;
    const prior = c.books.filter((b) => b.ts >= decisionTs - 75_000 && b.ts < decisionTs - 15_000); const priorDepths = prior.map((b) => b.depth).filter(Boolean); const priorMids = prior.map((b) => b.mid); const lows60 = c.books.filter((b) => b.ts >= decisionTs - 60_000).map((b) => b.bestBid);
    const value = { fi15: c.flow.fi(decisionTs - 15_000, decisionTs, FI_FLOOR_15), fi60: c.flow.fi(decisionTs - 60_000, decisionTs, FI_FLOOR_60), /* PUBLISH-FIX-83 item 8: a trade-count floor, window widened before it binds */ rv60: c.flow.rv60(decisionTs, cov), vwap60: c.flow.vwap(decisionTs - 60_000, decisionTs), priorFi: c.flow.fi(decisionTs - 75_000, decisionTs - 15_000), reclaimFi: c.flow.fi(decisionTs - 15_000, decisionTs), priorMidChange: priorMids.length >= 2 ? M.sub(priorMids[priorMids.length - 1], priorMids[0]) : null, priorMedianDepth: priorDepths.length ? medianDecimal(priorDepths) : null, priorDepthSamples: priorDepths.length, priorLow60: lows60.length ? minDecimal(lows60) : null }; // PUBLISH-FIX-112: exact minimum without a decimal parse per comparison
    c.windowFacts = { ts: decisionTs, epoch: cov?.epoch ?? null, value }; return value;
  }
  function fastFacts(c, snap, decisionTs) { const f = bookFacts(snap); const cov = feed ? feed.coverage(c.symbol, decisionTs) : { continuous: true, startTs: c.admittedTs, endTs: decisionTs }; const health = feed ? feed.health(c.symbol, decisionTs) : { bookAgeMs: decisionTs - snap.receiptTs }; const depthNow = bidDepthWithinBps(snap, 10); const w = windowFacts(c, decisionTs, cov);
    return { mid: f?.mid ?? null, bestBid: f?.bestBid ?? null, bestAsk: f?.bestAsk ?? null, fi15: w.fi15, fi60: w.fi60, rv60: w.rv60, coverage: cov, decisionTs, bookAgeMs: health.bookAgeMs ?? (decisionTs - snap.receiptTs), crcVerified: snap.crcVerified, depth10bps: depthNow, vwap60: w.vwap60, priorFi: w.priorFi, reclaimFi: w.reclaimFi, priorMidChange: w.priorMidChange, priorMedianDepth: w.priorMedianDepth, priorDepthSamples: w.priorDepthSamples, priorLow60: w.priorLow60, receiptSequence: snap.receiptSequence, feedEpoch: snap.feedEpoch, snapshotDigest: snap.digest };
  }
  // the prepared-fact view handed to the learned-contribution selector: the SAME already-computed fast facts,
  // reshaped into the learning feature contract (value + availability; UNKNOWN stays unavailable, never zero)
  const lf = (obj, key, unit, lookbackMs) => (obj && obj.state === 'KNOWN' && Number.isFinite(obj[key]) ? { value: obj[key], unit, lookbackMs, ageMs: 0, availability: 'KNOWN' } : { value: null, unit, lookbackMs, ageMs: null, availability: 'UNAVAILABLE' });
  const numFact = (v, unit, ageMs = 0) => (Number.isFinite(v) && Number.isFinite(ageMs) && ageMs >= 0 ? { value: v, unit, lookbackMs: 0, ageMs, availability: 'KNOWN' } : { value: null, unit, lookbackMs: 0, ageMs: null, availability: 'UNAVAILABLE' });
  function learnedFactsOf(fast, frozen = null) {
    const spreadBps = fast.bestBid && fast.bestAsk && fast.mid ? (Number(fast.bestAsk) - Number(fast.bestBid)) / Number(fast.mid) * 10_000 : null;
    const bookAge = Number.isFinite(fast.bookAgeMs) && fast.bookAgeMs >= 0 ? fast.bookAgeMs : null;
    const atrPct = frozen && frozen.atr14 !== undefined && fast.mid && Number.isFinite(Number(frozen.atr14)) && Number(fast.mid) > 0 ? Number(frozen.atr14) / Number(fast.mid) * 100 : NaN;
    return {
      rv60: lf(fast.rv60, 'rv60', 'ratio', 60_000), fi15: lf(fast.fi15, 'fi', 'fraction', 15_000), fi60: lf(fast.fi60, 'fi', 'fraction', 60_000),
      spreadBps: numFact(Number.isFinite(spreadBps) ? spreadBps : NaN, 'bps', bookAge),
      depthUsd10bps: numFact(fast.depth10bps !== null && Number.isFinite(Number(fast.depth10bps)) ? Number(fast.depth10bps) : NaN, 'usd_notional', bookAge),
      atrPct: numFact(atrPct, 'pct_of_mid', 0),
    };
  }
  // PUBLISH-FIX-83 (full review item 31): the frozen-reference probe is a pure function of (setup, bar block, the cached window facts, the
  // catalyst event); it was recomputed for every setup on every book (~150 µs a book at 170 books/s). It is memoized per candidate on
  // exactly those inputs; only its trigger clock is the book's. A real crossing freezes from the same probe, as before.
  function probeFor(c, setupId, ind, fast, triggerTs) {
    const memo = c.probeMemo ?? (c.probeMemo = new Map()); const ev = c.catalystEvent ?? null;
    const key = `${setupId}|${ind.blockDigest}|${c.windowFacts?.ts ?? ''}|${c.windowFacts?.epoch ?? ''}|${ev ? `${ev.eventId}|${ev.p0 ?? ''}|${ev.knownAtTs ?? ''}` : ''}`;
    let probe = memo.get(key);
    if (probe === undefined) { probe = freezeReferences({ setupId, ind, spec: c.spec, fast, event: ev, triggerTs }); memo.set(key, probe); if (memo.size > 24) memo.delete(memo.keys().next().value); counters.probeComputed = (counters.probeComputed ?? 0) + 1; } else counters.probeMemoHits = (counters.probeMemoHits ?? 0) + 1;
    return probe ? { ...probe, triggerTs } : null;
  }
  function onBook(e) { const c = candidates.get(e.symbol); if (!c) return; const snap = e.snapshot; if (!snap.synced) return; counters.books += 1; c.lastBook = snap; if (keepSnapshots) { c.snapshots.push(snap); while (c.snapshots.length && c.snapshots[0].receiptTs < snap.receiptTs - 180_000) c.snapshots.shift(); } const f = bookFacts(snap); if (!f) return; c.books.push({ ts: snap.receiptTs, seq: snap.receiptSequence, mid: f.mid, bestBid: f.bestBid, depth: bidDepthWithinBps(snap, 10), spread: f.spread }); while (c.books.length && c.books[0].ts < snap.receiptTs - 120_000) c.books.shift(); c.flow.advance(snap.receiptTs);
    const ind = c.indicators ?? refreshIndicators(c, snap.receiptTs); if (!ind) return;
    const fastOnce = fastFacts(c, snap, snap.receiptTs); // PUBLISH-FIX-10: the same snapshot, the same instant — computed once, not once per setup
    for (const setupId of setups) { if (setupId === 'CATALYST_TRANSMISSION' && !c.catalystEvent) continue; const tracker = c.episodes[setupId]; const fast = fastOnce; if (setupId === 'ABSORPTION_RECLAIM' && !fast.vwap60) continue; const probe = probeFor(c, setupId, ind, fast, snap.receiptTs); if (!probe) continue;
      const cur = tracker.current(); const level = cur ? cur.level : probe.triggerLevel; const r = tracker.observeMid(f.mid, level, snap.receiptTs);
      if (r.crossing) { counters.crossings += 1; if (secondLookCfg) { const p = c.secondLook.get(setupId); if (p && p.state === 'ARMED') { p.state = 'CROSSED'; p.looks += 1; p.episodeId = r.episode.episodeId; counters.secondLookCrossings += 1; } else if (p) { c.secondLook.delete(setupId); counters.secondLooksSuperseded = (counters.secondLooksSuperseded ?? 0) + 1; } } /* a natural crossing supersedes a waiting look (PUBLISH-FIX-83 item 37: counted) */ const frozen = { ...probe, strategyVersion: decisionStrategyVersion, triggerTs: snap.receiptTs, episodeId: r.episode.episodeId }; c.frozen.set(r.episode.episodeId, frozen); c.confirmations.set(r.episode.episodeId, createConfirmation({ level: frozen.triggerLevel, triggerTs: snap.receiptTs, expiryMs: policy.execution.proposalExpiryMs })); lockHypothesis(c, setupId, frozen, r.episode).catch((err) => log(`hypothesis lock failed: ${err.message}`)); }
      const ep = tracker.current(); if (!ep) continue; const conf = c.confirmations.get(ep.episodeId); if (!conf) continue; const st = conf.observe(f.mid, snap.receiptTs, snap.receiptSequence); if (st === 'CONFIRMED' && !ep.submitted) { if (ep.reoffer) ep.reoffer = false; else counters.confirmations += 1; ep.submitted = true; S.submit({ key: `${c.assetId}|${ep.episodeId}`, episodeId: ep.episodeId, snapshotSeq: snap.receiptSequence, receiptMono: clock.monotonic(), job: () => decide(c, setupId, ep.episodeId).catch((err) => { log(`decision failed: ${err.message}`); return null; }), onStale: () => { if (ep.state === 'PENDING') { ep.submitted = false; ep.reoffer = true; counters.staleReoffered += 1; } } }); } else if (st === 'EXPIRED') { counters.expired += 1; tracker.expire(snap.receiptTs + policy.execution.proposalExpiryMs + 1); recordRefusal(c, setupId, ep.episodeId, 'EXPIRED', c.frozen.get(ep.episodeId)?.awaitingLock ? ['PROPOSAL_EXPIRED_10S', 'HYPOTHESIS_NOT_DURABLE'] : ['PROPOSAL_EXPIRED_10S'], snap).catch(() => {}); c.confirmations.delete(ep.episodeId); } }
  }
  function onTrade(e) { const c = candidates.get(e.symbol); if (!c) return; counters.trades += 1; c.flow.add(e.trade); }
  // PUBLISH-FIX-70: lock commits COALESCE. Every crossing locks a hypothesis with its own serialized journal append; a coin that
  // oscillates around its trigger level (AKE/USD: 301 crossings in the first 3 minutes of 1e76a415, 363 commits, journal commit
  // p95 22 s) saturates the commit chain and every decision record queues behind it. Locks that arrive while a lock append is in
  // flight are committed together as ONE append (the journal appends a list atomically; the reducer applies them in order), so
  // the chain carries one append per round trip instead of one per crossing. A refused batch (one bad event) falls back to
  // committing each lock on its own, so one refusal never sinks the others. Each lock's own promise resolves when ITS append
  // lands; nothing about T, the lock-before-valuation law, the payload or the order of events changes.
  let lockBatch = []; let lockFlushing = false;
  async function flushLocks() {
    if (lockFlushing || !lockBatch.length) return; lockFlushing = true;
    try {
      while (lockBatch.length) {
        const batch = lockBatch; lockBatch = []; counters.lockBatches += 1; if (batch.length > 1) counters.lockCoalesced += batch.length - 1;
        try { await dispatcher.commit(batch.map((b) => b.event)); for (const b of batch) b.resolve(); }
        catch (err) { if (batch.length === 1) { batch[0].reject(err); continue; } for (const b of batch) { try { await dispatcher.commit(b.event); b.resolve(); } catch (e2) { b.reject(e2); } } }
      }
    } finally { lockFlushing = false; }
  }
  const commitLock = (event) => new Promise((resolve, reject) => { lockBatch.push({ event, resolve, reject }); flushLocks().catch(() => {}); });
  async function lockHypothesis(c, setupId, frozen, episode) { const decisionId = decisionIdentity({ accountId, episodeId: episode.episodeId, setupId, decisionKnownAtTs: frozen.triggerTs, snapshotDigest: null }); frozen.decisionId = decisionId; await commitLock(ev('HYPOTHESIS_LOCKED', { decisionId, episodeId: episode.episodeId, setupId, assetId: c.assetId, pair: c.symbol, hypothesisDigest: hypothesisDigest(frozen), frozenAtTs: frozen.triggerTs, triggerTs: frozen.triggerTs, expiresTs: frozen.triggerTs + policy.execution.proposalExpiryMs })); frozen.locked = true;
    // PUBLISH-FIX-68: a decision that ran before this lock was durable stepped aside (decide() below) instead of refusing; now that the
    // hypothesis IS durable, the still-pending episode is offered again by the next fresh book (the fix51 re-offer path, same episode,
    // same T, same 10 s) — one re-offer per lock, never a polling loop; past its 10 s the confirmation's own EXPIRED branch closes it
    if (frozen.awaitingLock) { const ep = c.episodes[setupId]?.current(); if (ep && ep.episodeId === episode.episodeId && ep.state === 'PENDING' && now() - frozen.triggerTs <= policy.execution.proposalExpiryMs) { frozen.awaitingLock = false; ep.submitted = false; ep.reoffer = true; counters.lockReoffered += 1; } }
  }
  // PUBLISH-FIX-83 (full review item 16): refusal records coalesce exactly like the hypothesis locks (PUBLISH-FIX-70) — a crossing storm
  // that produces twenty refusals inside one commit's round trip appends them as one batch instead of twenty serialized commits
  let refusalBatch = []; let refusalFlushing = false;
  async function flushRefusals() {
    if (refusalFlushing || !refusalBatch.length) return; refusalFlushing = true;
    try { while (refusalBatch.length) { const batch = refusalBatch; refusalBatch = []; counters.refusalBatches = (counters.refusalBatches ?? 0) + 1; if (batch.length > 1) counters.refusalsCoalesced = (counters.refusalsCoalesced ?? 0) + batch.length - 1; try { await dispatcher.commit(batch.map((b) => b.event)); for (const b of batch) b.resolve(); } catch (err) { if (batch.length === 1) { batch[0].reject(err); continue; } for (const b of batch) { try { await dispatcher.commit(b.event); b.resolve(); } catch (e2) { b.reject(e2); } } } } }
    finally { refusalFlushing = false; }
  }
  const commitRefusal = (event) => new Promise((resolve, reject) => { refusalBatch.push({ event, resolve, reject }); flushRefusals().catch(() => {}); });
  async function recordRefusal(c, setupId, episodeId, status, reasonCodes, snap, extra = {}) { const { verdicts = null, ...rest } = extra; const frozen = c.frozen.get(episodeId); const d = buildDecision({ c, setupId, episodeId, frozen, status, reasonCodes, snap, decisionTs: now(), ...rest }); await commitRefusal(ev('DECISION_RECORDED', decisionRecord(d, verdicts))); decisions.push(d); if (decisions.length > 256) decisions.shift(); offerToBridge(d); counters.decisions += 1; for (const r of reasonCodes) inc(refusals, r); return d; }
  function buildDecision({ c, setupId, episodeId, frozen, status, reasonCodes, snap, decisionTs, inputMode = 'MARKET_DIRECT', caseRefs = null, measurements = [], invalidation = null, scenario = null, valuationRef = null, sizing = null }) {
    const s = state(); const snapshotDigest = snap?.digest ?? null; const decisionId = frozen?.decisionId ?? decisionIdentity({ accountId, episodeId, setupId, decisionKnownAtTs: decisionTs, snapshotDigest });
    return makeDecision({ decisionId, accountId, mode: s.mode, strategyVersion: decisionStrategyVersion, policyDigest, costModelVersion: COST_MODEL_VERSION, asset: { canonicalCoin: c.assetId, venue: 'kraken', pair: c.symbol, specDigest: c.spec.specDigest }, episodeId, setupId, decisionKnownAtTs: decisionTs, triggerTs: frozen?.triggerTs ?? decisionTs, inputMode, caseRefs: caseRefs ?? { packetId: null, analysisId: null, caseId: null, caseCompletionTs: null, caseReceiptTs: null, direction: null, provenance: null, eventId: null, eventTaxonomy: null }, sourcePrefix: { snapshotDigest, feedEpoch: snap?.feedEpoch ?? null, receiptSequence: snap?.receiptSequence ?? null, barBlockDigest: c.indicators?.blockDigest ?? null, tradeCoverageStartTs: feed ? feed.coverage(c.symbol, decisionTs).startTs : null, tradeCoverageEndTs: feed ? feed.coverage(c.symbol, decisionTs).endTs : null }, featureSnapshotRef: c.indicators?.blockDigest ?? null, portfolioRevision: dispatcher.revision() ?? 0, restrictionRevision: Object.keys(s.restrictions).length, status, reasonCodes: [...new Set(reasonCodes)].slice(0, 64).map((r) => String(r).replace(/[^A-Za-z0-9._:@/+-]/g, '_').slice(0, 120)), measurements: measurements.slice(0, 64).map((m) => ({ ...(m.ablated === true ? { ablated: true } : {}), id: m.id, ok: m.ok, value: typeof m.value === 'number' || typeof m.value === 'boolean' || m.value === null ? m.value : String(m.value).slice(0, 64), threshold: typeof m.threshold === 'number' || typeof m.threshold === 'boolean' || m.threshold === null ? m.threshold : String(m.threshold).slice(0, 64), unit: m.unit, note: m.note ?? null })), predicates: [], invalidation, scenario, valuationRef, sizing });
  }
  // ---- the expensive decision at D ------------------------------------------------------------------------------------------------
  async function decide(c, setupId, episodeId) {
    const D = now(); const snap = c.lastBook; const frozen = c.frozen.get(episodeId); const tracker = c.episodes[setupId]; if (!frozen || !snap) return null;
    // PUBLISH-FIX-68: the lock commit is serialized behind every other journal write (a burst of crossings queues seconds of commits), so
    // the confirmation (>= 2 s after T) routinely arrives BEFORE the lock is durable. Inside the proposal's own 10 s that is not a refusal:
    // the decision steps aside and is re-offered the moment the lock lands (lockHypothesis above). Only a lock still not durable past the
    // 10 s is the NEEDS_DATA / HYPOTHESIS_NOT_DURABLE it always was. The price-blind law is untouched: no valuation before the durable lock.
    if (!frozen.locked) { if (D - frozen.triggerTs <= policy.execution.proposalExpiryMs) { frozen.awaitingLock = true; counters.lockWaits += 1; return null; } counters.needsData += 1; return recordRefusal(c, setupId, episodeId, 'NEEDS_DATA', ['HYPOTHESIS_NOT_DURABLE'], snap); }
    if (D - frozen.triggerTs > policy.execution.proposalExpiryMs) { counters.expired += 1; tracker.decide('EXPIRED', now()); return recordRefusal(c, setupId, episodeId, 'EXPIRED', ['PROPOSAL_EXPIRED_10S'], snap); }
    const lag = D - snap.receiptTs; if (lag > policy.execution.maxReceiptToDecisionLagMs) { counters.queueDelayExpired += 1; tracker.decide('NEEDS_DATA', now()); rearmAfterInfra(c, setupId, `receipt-to-decision lag ${lag}ms`); return recordRefusal(c, setupId, episodeId, 'NEEDS_DATA', ['RECEIPT_TO_DECISION_LAG_EXCEEDED'], snap); }
    const ind = c.indicators; const fast = fastFacts(c, snap, D); const entry = fast.bestAsk; if (!ind || !entry) { tracker.decide('NEEDS_DATA', now()); rearmAfterInfra(c, setupId, ind ? 'no book' : `no indicators (${c.indicatorsReason ?? '?'})`); return recordRefusal(c, setupId, episodeId, 'NEEDS_DATA', ['NO_INDICATORS_OR_BOOK'], snap); }
    // intake: MARKET_DIRECT for I-III unless a case is supplied; IV needs the verified catalyst case
    const consumed = caseSource.consumed(c.assetId, { decisionTs: D }); let inputMode = 'MARKET_DIRECT'; let catalyst = null; if (setupId === 'CATALYST_TRANSMISSION') inputMode = 'CATALYST_CASE'; else if (consumed) inputMode = 'CASE_ENRICHED';
    if (consumed && consumed.ok) catalyst = primaryConfirmedCatalyst({ packet: consumed.packet, analysis: consumed.analysis, canonicalCoin: c.assetId, decisionTs: D });
    if (consumed && consumed.ok) { if (provenance.size >= 4096) provenance.delete(provenance.keys().next().value); provenance.set(`${episodeId}|${D}`, { caseId: consumed.caseId ?? null, catalystId: catalyst?.ok ? catalyst.event.eventId : null, sourceId: catalyst?.ok ? catalyst.event.sourceId : null }); }
    const intake = intakeDecision({ inputMode, caseConsumption: consumed, catalyst, setupId }); const caseRefs = { packetId: intake.packetId ?? null, analysisId: intake.analysisId ?? null, caseId: intake.caseId ?? null, caseCompletionTs: intake.caseCompletionTs ?? null, caseReceiptTs: intake.caseReceiptTs ?? null, direction: intake.direction ?? null, provenance: intake.provenance ?? null, eventId: intake.event?.eventId ?? null, eventTaxonomy: intake.event?.taxonomy ?? null };
    if (!intake.ok) { if (intake.reasons.includes('CASE_INVALID_REJECTED_NOT_STRIPPED')) counters.modelStale += 1; tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, setupId === 'CATALYST_TRANSMISSION' && !consumed ? 'NEEDS_DATA' : 'ENTRY_REFUSED', intake.reasons, snap, { inputMode: intake.ok ? inputMode : 'MARKET_DIRECT' }); }
    // the absorption feature windows are anchored at the FROZEN trigger T (closeout R10): [T-15s,T) is measured from the tracker at D, never [D-15s,D)
    const atTrigger = setupId === 'ABSORPTION_RECLAIM' ? { reclaimFi: c.flow.fi(frozen.triggerTs - 15_000, frozen.triggerTs, { ...FI_FLOOR_15, asOfTs: D }), vwap60: c.flow.vwap(frozen.triggerTs - 60_000, frozen.triggerTs, { asOfTs: D }) } : null; // PUBLISH-FIX-83 item 11: known-by-D, so a pre-T print received a few ms after T is not dropped
    const operationalFacts = edgeStateEnabled && isEdgeSetup(setupId)
      ? deriveOperationalEntryFacts({ setupId, decisionTs: D, frozen, fast, books: c.books, catalyst: intake.event ?? c.catalystEvent ?? null })
      : null;
    const evaluatedFast = operationalFacts ? { ...fast, ...operationalFacts } : fast;
    const learnedLines = learnedLinesNow(setupId); /* PUBLISH-FIX-82: one read per decision, per setup (RV60 is learned per setup) */ const setup = evaluateSetup({ setupId, frozen, ind, fast: atTrigger ? { ...evaluatedFast, atTrigger } : evaluatedFast, bars: c.indicatorsRef.bars, entry, decisionTs: D, event: intake.event ?? c.catalystEvent ?? null, ablate: armRule?.ablate ?? null, learned: learnedLines }); const baseMeasurements = [...setup.clauses, ...gateLearningMeasurement(learnedLines, setupId)];
    // learned contribution (dormant without the injected port): resolved from the prepared snapshot and THIS
    // decision's already-prepared facts only; any resolver fault falls back to baseline with the fault logged
    let learned = null;
    const learnedFacts = learnedFactsOf(fast, frozen); // PUBLISH-FIX-38: prepared once, handed to the selector AND recorded on the decision
    if (learning) { try { learned = resolveLearningContribution({ snapshot: learning.snapshot(), facts: { setupType: setupId, regime: 'LIVE_UNCLASSIFIED', asset: c.assetId, venue: 'kraken', featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyVersion: policyDigest, features: learnedFacts }, mode, nowTs: D }); } catch (err) { log(`learned contribution resolver failed (baseline): ${err.message}`); learned = null; } }
    const factRows = learning ? learnedFactMeasurements(learnedFacts) : []; // PUBLISH-FIX-38: with a learning port composed, the six facts ride every decision's measurements (ports absent: the baseline record, byte for byte)
    let measurements = learned ? [...baseMeasurements, ...factRows, contributionMeasurement(learned), ...contributionCandidateLog(learned)] : [...baseMeasurements, ...factRows];
    // PUBLISH-FIX-73 (the move clock): with the port composed, every decision records where the coin is in its own move (age since the
    // hour's low, climb since) beside the lesson the mover study taught; the refusal below fires only for an ELIGIBLE setup while the
    // lesson is ARMED. Port absent: nothing here runs and the record is the baseline byte for byte. A faulting port reads as absent.
    let moveClockVerdictNow = null;
    if (moveClock) { try { const lesson = typeof moveClock.lesson === 'function' ? moveClock.lesson() : null; let clockBars = null; try { clockBars = history.bars(c.symbol, D, MOVE_CLOCK_BARS); } catch { clockBars = null; } const facts = moveClockFacts(Array.isArray(clockBars) && clockBars.length >= c.indicatorsRef.bars.length ? clockBars : c.indicatorsRef.bars, D, { minClimbPct: lesson?.minClimbPct }); /* PUBLISH-FIX-81: a two-hour block when the history has it */ moveClockVerdictNow = moveClockVerdict(facts, lesson); measurements = [...measurements, ...moveClockMeasurements(facts, lesson, moveClockVerdictNow)]; } catch (err) { log(`move clock port failed (baseline for this decision): ${String(err?.message ?? err).slice(0, 160)}`); moveClockVerdictNow = null; } }
    if (secondLookCfg) measurements = [...measurements, ...secondLookMeasurement(c, setupId, episodeId)]; // PUBLISH-FIX-79: a decision made on a second look says so
    if (setup.state !== 'ELIGIBLE') { if (setup.state === 'NEEDS_DATA') { counters.needsData += 1; scheduleDataLook(c, setupId, frozen, setup.refused, D, fast); } else scheduleSecondLook(c, setupId, frozen, setup.refused, D); tracker.decide(setup.state === 'NEEDS_DATA' ? 'NEEDS_DATA' : 'ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, setup.state === 'NEEDS_DATA' ? 'NEEDS_DATA' : 'NO_TRADE', setup.refused, snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
    funnel.setupQualified += 1; if (secondLookCfg) c.secondLook.delete(setupId); // PUBLISH-FIX-79: an eligible look ends the chain
    if (moveClockVerdictNow && !moveClockVerdictNow.ok) { counters.moveTooOld += 1; tracker.decide('NO_TRADE', now()); return recordRefusal(c, setupId, episodeId, 'NO_TRADE', moveClockVerdictNow.refused, snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); } // PUBLISH-FIX-73: the move is already as old as the minute most movers top out by
    let operationalDurationMs = policy.execution.maxDurationMs;
    if (setupSelectionEnabled && !isEdgeSetup(setupId)) {
      const duration = setupDurationBound({ policyMaxDurationMs: policy.execution.maxDurationMs, setupMaxDurationMs: setup.maxDurationMs });
      if (!duration.ok) { tracker.decide('NO_TRADE', now()); return recordRefusal(c, setupId, episodeId, 'NO_TRADE', [duration.reason], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
      operationalDurationMs = duration.maxDurationMs;
    }
    // a seeded nomination control (focused completion §5): ONE deterministic draw per canonical episode, before any reservation, never redrawn
    if (armRule?.nominationFilter && !armRule.nominationFilter({ episodeId, assetId: c.assetId, setupId })) { tracker.decide('NO_TRADE', now()); return recordRefusal(c, setupId, episodeId, 'NO_TRADE', ['SEEDED_CONTROL_NOT_SELECTED'], snap, { inputMode, caseRefs, measurements }); }
    // permission intersection: controls, mode, restrictions, health, clock
    // ONE shared law with the dispatcher's pre-send check (closeout R01): controls, restrictions, mode, authorization, clock, writer
    const s = state(); const persistencePermission = permissionIncreaseGate(); const blocked = [...entryPermission(s, { controls: controls(), nowTs: D, assetId: c.assetId, pair: c.symbol, runMode: mode, clockTrusted: clock.status ? clock.status().trusted !== false : true, writerHeld: dispatcher.writerHeld ? dispatcher.writerHeld() && !dispatcher.writerLost() : true }).reasons];
    if (!persistencePermission.ok) blocked.push(persistencePermission.reason);
    if (blocked.length) { tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', blocked, snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
    if (setup.scenario.target === null) { tracker.decide('NO_TRADE', now()); return recordRefusal(c, setupId, episodeId, 'NO_TRADE', ['NO_SCENARIO_TARGET'], snap, { inputMode, caseRefs, measurements }); }
    // cost + size (largest legal lot inside cash, stressed risk, cluster caps) — computed OUTSIDE the account lock
    const clusterId = clusterIdOf(clusters(), c.assetId); const budget = riskBudgetFor({ state: s, limits: s.limits, lockLevel: lockLevel(), clusterId }); if (!budget) { tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', ['EQUITY_UNKNOWN'], snap, { inputMode, caseRefs, measurements }); }
    const fee = feeOf(c.symbol);
    // sizing: the exact existing search when the dynamic-sizing switch is off; the size ladder over the SAME
    // risk-bounded budget and SAME cost law when it is on, with every candidate size recorded
    let found;
    if (dynamicSizing) {
      // the ladder's prepared inputs come ONLY from what this decision already holds: the UNCHANGED admission law
      // per size (concentration/cluster/reservations/risk caps), the freshness law from policy, and — only when a
      // forward-validated candidate applies AND declares one — its maximum evidence-supported size. budget.cash is
      // caps.cashAvailable, already net of open reservations. Nothing is invented; absent evidence keeps
      // full-balance ineligible inside the ladder.
      const prepared = {
        admissible: (ev2) => admitCandidate({ state: s, candidate: { assetId: c.assetId, clusterId, entryCashOut: ev2.entryCashOut, riskUsd: ev2.scenarioStressedLoss, decisionId: frozen.decisionId }, limits: s.limits, lockLevel: lockLevel(), clusters: clusters() }),
        candidateMaxSizeUsd: learned?.applied && Number.isFinite(learned.selected?.maxSizeUsd) ? learned.selected.maxSizeUsd : null,
        maxBookAgeMs: policy.execution.maxBookAgeMs,
      };
      const ladder = evaluateSizeLadder({ snapshot: snap, spec: c.spec, fee, atr14: frozen.atr14, structuralStop: frozen.structuralStop, targetPrice: setup.scenario.target, maxEntryLevel: setup.maxEntryLevel, cashAvailable: budget.cash, riskBudget: budget.budget, fractions: dynamicSizing.fractions ?? undefined, allInEvidence: dynamicSizing.allInEvidence ?? undefined, prepared, nowTs: D });
      measurements = [...measurements, sizingMeasurement(ladder), ...sizingCandidateLog(ladder)];
      if (!ladder.selected) { closeCall(c, setupId, ['NO_ELIGIBLE_SIZE_ON_LADDER'], ladder.candidates.filter((x) => x.status !== 'OK').slice(0, 3).map((x) => String(x.reason)).concat(ladder.candidates.filter((x) => x.status === 'OK').slice(0, 2).map((x) => `${x.whyNotSelected ?? 'NOT_SELECTED'} p=${x.bufferedScenarioNetProfit} risk=${x.scenarioStressedLoss}`)), budget, setup); tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', ['NO_TRADE_SIZE', 'NO_ELIGIBLE_SIZE_ON_LADDER'], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
      found = ladder.selected.found;
    } else {
      found = sizeSearch({ snapshot: snap, spec: c.spec, fee, atr14: frozen.atr14, structuralStop: frozen.structuralStop, targetPrice: setup.scenario.target, maxEntryLevel: setup.maxEntryLevel, cashAvailable: budget.cash, riskBudget: budget.budget });
    }
    if (found.status !== 'OK') { closeCall(c, setupId, [found.reason, ...(found.binding ?? [])], found.evaluation ? [`p=${found.evaluation.bufferedScenarioNetProfit ?? '?'} risk=${found.evaluation.scenarioStressedLoss ?? '?'} cashOut=${found.evaluation.entryCashOut ?? '?'}`] : [], budget, setup); tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', ['NO_TRADE_SIZE', found.reason, ...(found.binding ?? [])], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
    const e = found.evaluation;
    if (edgeStateEnabled && isEdgeSetup(setupId)) {
      const executableEdge = executableEdgeFromEvaluation({ setupId, evaluation: e, decisionTs: D });
      const executionGate = evaluateStyleExecutionGate({ setupId, executableEdge, decisionTs: D });
      measurements = [...measurements, ...executionGate.clauses];
      if (executionGate.state !== 'ELIGIBLE') { tracker.decide(executionGate.state === 'NEEDS_DATA' ? 'NEEDS_DATA' : 'ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, executionGate.state === 'NEEDS_DATA' ? 'NEEDS_DATA' : 'NO_TRADE', ['POST_SIZE_EXECUTION_GATE', ...executionGate.refused], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' } }); }
    }
    funnel.costQualifiedAtLegalSize += 1;
    const admission = admitCandidate({ state: s, candidate: { assetId: c.assetId, clusterId, entryCashOut: e.entryCashOut, riskUsd: e.scenarioStressedLoss, decisionId: frozen.decisionId }, limits: s.limits, lockLevel: lockLevel(), clusters: clusters() });
    const valuationRef = { snapshotDigest: snap.digest, entryLimitPrice: e.entryLimitPrice, entryCashOut: e.entryCashOut, entryBookEstimateCashOut: e.entryBookEstimate.cashOut, scenarioExitCashIn: e.scenarioExitCashIn, scenarioNetProfit: e.scenarioNetProfit, executionUncertaintyBuffer: e.executionUncertaintyBuffer, bufferedScenarioNetProfit: e.bufferedScenarioNetProfit, scenarioStressedLoss: e.scenarioStressedLoss, rewardRiskRatio: e.rewardRiskRatio, feeDigest: fee.feeDigest, expectancyState: 'UNCALIBRATED' };
    const sizing = { q: found.q, entryLimitPrice: e.entryLimitPrice, entryCashOut: e.entryCashOut, riskUsd: e.scenarioStressedLoss, bufferedScenarioNetProfit: e.bufferedScenarioNetProfit, binding: found.binding, clusterId };
    // challenger verdicts (focused completion §5) computed from REAL inputs at D through the production feature functions: an arm admits only
    // on its declared law (D1 KNOWN ALLOW, D2 KNOWN ALLOW / NO_RULE, D3 KNOWN ALLOW); UNKNOWN never admits; every verdict is a closed record
    let verdicts = null; if (armRule?.challengers?.length) { const ch = challengerVerdicts({ c, D, snap, fast, found, e, fee, setupId, episodeId, frozen }); verdicts = ch.verdicts; if (ch.blocked.length) { tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', ch.blocked, snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' }, valuationRef, sizing, verdicts }); } }
    if (!admission.ok) {
      // PUBLISH-FIX-102 (2026-09-21): a look that passed every gate AND found a size and is then refused by a RESTRICTION is the
      // loudest thing that can happen short of a bite, and it left one word in the ledger. Between 2026-09-17 19:28 and
      // 2026-09-19 13:24 the CAGE ate 28 of these and the owner was never told, on any line, that a control of his was the reason.
      counters.restrictionRefusals = (counters.restrictionRefusals ?? 0) + 1;
      counters.restrictionReasons = counters.restrictionReasons ?? {};
      for (const r of admission.reasons) if (counters.restrictionReasons[r] !== undefined || Object.keys(counters.restrictionReasons).length < 24) counters.restrictionReasons[r] = (counters.restrictionReasons[r] ?? 0) + 1;
      log(`RESTRICTION BLOCKED A BITE: ${c.symbol} ${setupId} passed every gate and found a size (${found.q} at ${e.entryLimitPrice}, risk ${e.scenarioStressedLoss}) — refused by ${admission.reasons.join(', ')}. This is a CONTROL, not the market: it stays until the owner clears it.`);
      tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', admission.reasons, snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' }, valuationRef, sizing, verdicts });
    }
    const adaptiveRank = resolveAdaptiveRanking({ c, setupId, D, snap, evaluation: e });
    if (adaptiveRank) measurements = [...measurements, adaptiveRank.measurement];
    // ranked admission: wait for this pass's batch to be ordered, then re-admit against the state the earlier winners left behind
    // the ONE allowlisted learned effect: a bounded nudge to the RANK KEY of an already fully qualified candidate.
    // It can only reorder this admission batch; it cannot admit, size, or bypass anything, and the committed
    // valuationRef/sizing keep the untouched baseline ratio.
    // The adaptive and legacy selectors carry different units and different
    // qualification contracts. Configuring the typed adaptive hook selects
    // that rank channel for the entire batch: an individual adaptive baseline
    // result remains the executable baseline, never an invitation to add the
    // legacy RANK_SCORE_UNITS effect for another candidate in the same batch.
    const rankRatio = adaptiveHookConfigured
      ? (adaptiveRank?.applied ? adaptiveRank.effectiveRewardRiskRatio : e.rewardRiskRatio)
      : learned?.applied && e.rewardRiskRatio !== null && Number.isFinite(Number(e.rewardRiskRatio))
        ? Number(e.rewardRiskRatio) + learned.adjust : e.rewardRiskRatio;
    const rank = { rewardRiskRatio: rankRatio, costBps: e.costBps ?? null, firstKnownTs: c.nominationKnownAtTs, assetId: c.assetId };
    if (setupSelectionEnabled) Object.assign(rank, { setupId, decisionId: frozen.decisionId });
    const slot = await admissionGate({ rank }); c.lastRank = { rank: slot.rank, of: slot.of, ts: D };
    if (setupSelectionEnabled) {
      measurements = [...measurements, selectionMeasurement({ setupId, selected: slot.selected, winnerSetupId: slot.winnerSetupId, rank: slot.rank, of: slot.of })];
      if (!slot.selected) { tracker.decide('NO_TRADE', now()); return recordRefusal(c, setupId, episodeId, 'NO_TRADE', ['STRATEGY_NOT_SELECTED_SAME_UNDERLYING'], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' }, valuationRef, sizing, verdicts }); }
    }
    let claimedUnderlying = false;
    try {
    const again = admitCandidate({ state: state(), candidate: { assetId: c.assetId, clusterId, entryCashOut: e.entryCashOut, riskUsd: e.scenarioStressedLoss, decisionId: frozen.decisionId }, limits: state().limits, lockLevel: lockLevel(), clusters: clusters() });
    if (!again.ok) { tracker.decide('ENTRY_REFUSED', now()); return await recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', [...again.reasons, `RANKED_${slot.rank}_OF_${slot.of}`], snap, { inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' }, valuationRef, sizing, verdicts }); }
    // ONE transaction: decision + reservation + shell + pin + outbox intent, rechecked against the current revision
    const decision = buildDecision({ c, setupId, episodeId, frozen, status: 'ENTRY_RESERVED', reasonCodes: [], snap, decisionTs: D, inputMode, caseRefs, measurements, invalidation: setup.invalidation, scenario: { target: setup.scenario.target, cappedBy: setup.scenario.cappedBy?.price ?? null, kind: 'SCENARIO_NOT_FORECAST' }, valuationRef, sizing });
    const n = Object.keys(s.orders).length + 1; const positionId = `pos-${c.assetId}-${D}-${n}`; const reservationId = `res-${decision.decisionId.slice(4, 20)}`; const orderId = `ord-${c.assetId}-${D}-${n}`; const clientOrderId = `s${(D % 1e9).toString(36)}${n.toString(36)}`.slice(0, 18);
    const management = edgeStateEnabled && isEdgeSetup(setupId) ? edgePositionManagement({ setupId, hardMaxDurationMs: canaryDurationBound(s, operationalDurationMs), selectionVersion: setupSelection.version }) : null;
    const events = [ev('DECISION_RECORDED', decisionRecord(decision, verdicts)), ev('RESERVATION_OPENED', { reservationId, decisionId: decision.decisionId, assetId: c.assetId, pair: c.symbol, cashReserved: e.entryCashOut, riskReserved: e.scenarioStressedLoss, clusterId, expiresTs: D + policy.execution.proposalExpiryMs }), ev('POSITION_OPENED', { positionId, decisionId: decision.decisionId, assetId: c.assetId, pair: c.symbol, specDigest: c.spec.specDigest, structuralStop: frozen.structuralStop, targetPrice: setup.scenario.target, targetProceedsRecipe: 'SHIFTED_BOOK_STRESS_50', atr14: frozen.atr14, maxDurationMs: canaryDurationBound(s, operationalDurationMs), feedPinned: true, requestedQty: found.q, clusterId, ...(management ? { management } : {}) }), ev('FEED_PIN', { symbol: c.symbol, action: 'PIN', reason: `position shell ${positionId}`, ts: D }), ev('ORDER_INTENT', { intentId: `int-${orderId}`, orderId, clientOrderId, reservationId, positionId, kind: s.authorization && !s.authorization.ended && s.authorization.kind === 'CANARY' ? 'CANARY_ENTRY' : 'ENTRY', side: 'buy', pair: c.symbol, qty: found.q, limitPrice: e.entryLimitPrice, orderType: 'limit', timeInForce: 'IOC', protection: { ordertype: 'stop-loss', trigger: 'last', price: M.roundToStep(frozen.structuralStop, c.spec.priceIncrement, 'FLOOR') }, deadlineTs: D + policy.execution.entryDeadlineMs, feeDigest: fee.feeDigest, specDigest: c.spec.specDigest, snapshotDigest: snap.digest, createdTs: D })];
    const revisionSeen = dispatcher.revision();
    // the valued snapshot is persisted BEFORE the durable intent (closeout R11): a dispatched order references evidence on disk
    if (snapshotStore) { const persisted = await snapshotStore.persist(snap, { purpose: 'DECISION', ref: decision.decisionId }); if (!persisted.ok) { counters.snapshotPersistFailures += 1; tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', ['DECISION_SNAPSHOT_NOT_PERSISTED'], snap, { inputMode, caseRefs, measurements, valuationRef, sizing }); } }
    let commitPermissionRefusal = null;
    try { await dispatcher.commit(events, { priority: true, retryOnConflict: true, recheck: (cur) => { const p = permissionIncreaseGate(); if (!p.ok) { commitPermissionRefusal = p.reason; return false; } return (dispatcher.revision() === revisionSeen || admitCandidate({ state: cur, candidate: { assetId: c.assetId, clusterId, entryCashOut: e.entryCashOut, riskUsd: e.scenarioStressedLoss, decisionId: frozen.decisionId }, limits: cur.limits, lockLevel: lockLevel(), clusters: clusters() }).ok) && !entryBlockingRestrictions(cur).length; } }); claimedUnderlying = true; } catch (err) { counters.revalidationRefusals += 1; tracker.decide('ENTRY_REFUSED', now()); return recordRefusal(c, setupId, episodeId, 'ENTRY_REFUSED', [commitPermissionRefusal ?? (err.code === 'REDUCER_REFUSED' ? err.detail.code : err.code ?? 'COMMIT_FAILED')], snap, { inputMode, caseRefs, measurements, valuationRef, sizing }); }
    if (feed) feed.admit(c.symbol, { coin: c.assetId, priority: 'PENDING', reason: positionId }); funnel.reserved += 1; decisions.push(decision); if (decisions.length > 256) decisions.shift(); offerToBridge(decision); counters.decisions += 1; tracker.decide('ENTRY_RESERVED', now());
    // last-moment revalidation on the freshest accepted book (one retry law: a changed book that cannot buy q at the limit refuses and releases the unsent reservation)
    const fresh = c.lastBook; if (fresh && fresh.digest !== snap.digest) { const again = evaluateEntry({ snapshot: fresh, q: found.q, spec: c.spec, fee, atr14: frozen.atr14, structuralStop: frozen.structuralStop, targetPrice: setup.scenario.target, maxEntryLevel: setup.maxEntryLevel }); if (again.status !== 'OK' || M.gt(again.entryLimitPrice, e.entryLimitPrice) || (now() - fresh.receiptTs) > policy.execution.maxBookAgeMs) { counters.revalidationRefusals += 1; await dispatcher.commit([ev('ORDER_STATE', { orderId, state: 'CANCELLED', nativeOrderId: null, nativeCumQty: '0', reason: `revalidation refused before dispatch: ${again.reasons?.join(',') || 'limit would rise / book stale'}`, sourceTs: null, receiptTs: now() }), ev('RESERVATION_RELEASED', { reservationId, reason: 'REFUSED_AT_REVALIDATION', releasedCash: e.entryCashOut, releasedRisk: e.scenarioStressedLoss, ts: now() })]); if (feed) feed.admit(c.symbol, { coin: c.assetId, priority: 'CANDIDATE' }); return decision; } }
    funnel.sent += 1; counters.entries += 1; lastEntryMono = clock.monotonic(); const queued = typeof dispatcher.queueEntry === 'function' ? dispatcher.queueEntry(orderId) : dispatcher.enqueue('ENTRY', () => dispatcher.dispatchEntry(orderId)); queued.catch((err) => log(`dispatch ${orderId}: ${err.message}`)); return decision;
    } finally { if (setupSelectionEnabled) slot.done({ claimed: claimedUnderlying }); else slot.done(); }
  }
  // ---- challenger verdicts at D (research arms only) --------------------------------------------------------------------------------
  const boundedFeature = (f) => JSON.parse(JSON.stringify(f, (k, v) => (Array.isArray(v) && v.length > 32 ? v.slice(0, 32) : v)));
  // 60s mid returns for the target and its frozen peers from THIS arm's accepted books: an endpoint outside the books is missing, never filled
  function midAt(assetId, ts) { const c = [...candidates.values()].find((x) => x.assetId === assetId); if (!c) return null; let best = null; for (const b of c.books) { if (b.ts <= ts && b.ts >= ts - 5000) best = b; if (b.ts > ts) break; } return best ? best.mid : null; }
  function returnsFor({ self, peers, startTs, endTs, recorded = null }) { const out = {}; for (const a of [self, ...peers.map((p) => p.asset)]) { const s = midAt(a, startTs); const e = midAt(a, endTs); if (s !== null && e !== null) out[a] = { startTs, endTs, startMid: s, endMid: e, source: 'ARM_BOOKS' }; else if (recorded?.[a] && recorded[a].startTs === startTs && recorded[a].endTs === endTs) out[a] = { ...recorded[a], source: 'PEER_RECORD' }; } return out; }
  function challengerVerdicts({ c, D, snap, fast, found, e, fee, setupId, episodeId, frozen }) {
    const verdicts = {}; const blocked = []; const records = []; const trades = c.flow.window(D - 180_000, D); const books = c.snapshots;
    for (const ch of armRule.challengers) { let f;
      if (ch === 'D1_PRESSURE_TO_PROGRESS') f = d1Feature({ trades, books, decisionTs: D, proposedNotional: e.entryCashOut, snapshot: snap, q: found.q, spec: c.spec, fee, liquidation: liquidationValue });
      else if (ch === 'D2_FLOW_EVENT_RESPONSE') { const w = armRule.inputs?.whale ? armRule.inputs.whale(c.assetId, D) : null; const anomaly = w ? transferAnomaly((w.intervals ?? []).filter((x) => x.knownAtTs <= D)) : { state: 'UNKNOWN', reason: 'NO_WHALE_INPUT' }; f = d2Feature({ anomaly, trades, books, decisionTs: D, coverage: fast.coverage }); }
      else if (ch === 'D3_RESIDUAL_IGNITION') { const p = armRule.inputs?.peers ? armRule.inputs.peers(D) : null; const membership = p ? peerMembership({ census: p.census, rankings: p.rankings, selectionTs: p.selectionTs, self: c.assetId, excludeBases: policy.universe.excludeBases }) : { state: 'UNKNOWN', reason: 'NO_PEER_INPUT' }; const returns = membership.state === 'KNOWN' ? returnsFor({ self: c.assetId, peers: membership.peers, startTs: D - 60_000, endTs: D, recorded: p?.returns ?? null }) : {}; f = d3Feature({ membership, returns, decisionTs: D }); }
      else f = { challenger: ch, state: 'UNKNOWN', restriction: 'UNKNOWN', reason: 'CHALLENGER_UNKNOWN' };
      const word = VERDICT_WORDS.includes(f.restriction) ? f.restriction : 'UNKNOWN'; verdicts[ch] = word; const admits = f.state === 'KNOWN' && (word === 'ALLOW' || (ch === 'D2_FLOW_EVENT_RESPONSE' && word === 'NO_RULE'));
      if (!admits) blocked.push(`${ch}_${word}${f.reason ? `:${String(f.reason).slice(0, 48)}` : ''}`);
      records.push({ verdictVersion: VERDICT_RECORD_VERSION, accountId, decisionId: frozen.decisionId, episodeId, assetId: c.assetId, pair: c.symbol, setupId, decisionTs: D, challenger: ch, state: f.state, restriction: word, reason: f.reason ?? null, admits, feature: boundedFeature(f) }); }
    if (verdictSink) for (const r of records) { try { verdictSink(r); } catch (err) { log(`verdict sink: ${err.message}`); } }
    return { verdicts, blocked, records };
  }
  function fireSecondLooks(c, nowTs) { // PUBLISH-FIX-79: a due second look re-arms the tracker when the coin still sits at/above its level
    for (const [setupId, p] of c.secondLook) {
      if (p.state !== 'WAITING' || nowTs < p.dueTs) continue;
      const tracker = c.episodes[setupId]; const snap = c.lastBook; const f = snap ? bookFacts(snap) : null;
      if (!f || nowTs - snap.receiptTs > secondLookCfg.staleMs || !tracker || tracker.current()) { if (nowTs - p.dueTs > secondLookCfg.staleMs) { counters.secondLooksDropped += 1; c.secondLook.delete(setupId); } continue; }
      if (M.lt(f.mid, p.level)) { counters.secondLooksDropped += 1; c.secondLook.delete(setupId); continue; } // the thesis is gone; a natural re-cross will come
      if (tracker.rearm()) { p.state = 'ARMED'; counters.secondLooksArmed += 1; log(`second look armed: ${c.symbol} ${setupId} look ${p.looks + 1} of ${secondLookCfg.maxLooks}, ${Math.round((nowTs - (p.dueTs - secondLookCfg.afterMs)) / 60_000)} min after a flow-only refusal (${p.refused.join(',')}); mid ${f.mid} at/above level ${p.level}`); }
    }
  }
  async function onTick(nowTs = now()) { for (const c of candidates.values()) { c.flow.advance(nowTs); if (secondLookCfg && c.secondLook.size) fireSecondLooks(c, nowTs); for (const [setupId, tr] of Object.entries(c.episodes)) { const gone = tr.expire(nowTs); if (gone) { counters.expired += 1; c.confirmations.delete(gone.episodeId); const lockLate = Boolean(c.frozen.get(gone.episodeId)?.awaitingLock); recordRefusal(c, setupId, gone.episodeId, 'EXPIRED', lockLate ? ['PROPOSAL_EXPIRED_10S', 'HYPOTHESIS_NOT_DURABLE'] : ['PROPOSAL_EXPIRED_10S'], c.lastBook).catch(() => {}); if (lockLate) rearmAfterInfra(c, setupId, 'hypothesis lock not durable within 10 s'); /* PUBLISH-FIX-83 item 13 */ } } if (!c.indicators || nowTs - (c.indicators.referenceTs ?? 0) >= 60_000) refreshIndicators(c, nowTs); c.readiness = judgeReadinessMatrix(c, { bars: c.lastBars ?? null, flowCoverage: feed ? feed.coverage(c.symbol, nowTs) : { continuous: true, startTs: c.admittedTs }, bookHealth: feed ? feed.health(c.symbol, nowTs) : { usable: Boolean(c.lastBook) }, baselineBooks: c.books.length, caseState: c.catalystEvent ? 'VERIFIED' : null, controls: { vetoed: (controls().vetoes ?? []).includes(c.assetId), caged: controls().cage }, instrumentOk: c.spec.status === 'online', nowTs }); if (Object.values(c.readiness).some((r) => r.state === 'READY_TO_EVALUATE') && !c.warmedCounted) { c.warmedCounted = true; funnel.warmed += 1; } } await S.tick(); }
  // a closed position returns its symbol to cooldown; the funnel counts protection / close from journal state
  function onCommit(s, events) { for (const e of events) { if (e.type === 'EXECUTION_RECORDED' && e.payload.side === 'buy') funnel.filled += 1; if (e.type === 'PROTECTION_STATE' && e.payload.state === 'ACTIVE') funnel.protected += 1; if (e.type === 'POSITION_CLOSED') { funnel.closedReconciled += 1; const pos = s.positions[e.payload.positionId]; const c = pos ? candidates.get(pos.pair) : null; if (c) for (const tr of Object.values(c.episodes)) tr.closed(e.payload.ts); } } }
  dispatcher.onCommit(onCommit); if (feed) feed.subscribe((e) => { if (e.kind === 'BOOK') onBook(e); else if (e.kind === 'TRADE') onTrade(e); });
  return { admit, release, onBook, onTrade, onTick, decide, drain: () => S.drain(), takeDecisions: () => bridgeQueue.splice(0, bridgeQueue.length), bridgeQueueDepth: () => bridgeQueue.length, candidates: () => [...candidates.values()].map((c) => ({ symbol: c.symbol, assetId: c.assetId, priority: c.priority, lastRank: c.lastRank ?? null, catalystEvent: c.catalystEvent ?? null, indicators: c.indicators ? { atr14: c.indicators.atr14, h20: c.indicators.h20, l20: c.indicators.l20, blockDigest: c.indicators.blockDigest.slice(0, 16) } : null, indicatorsReason: c.indicatorsReason ?? null, readiness: c.readiness, books: c.books.length, flow: c.flow.status(), episodes: Object.fromEntries(Object.entries(c.episodes).map(([k, v]) => [k, v.status()])), secondLooks: Object.fromEntries([...c.secondLook.entries()].map(([k, v]) => [k, { ...v }])) /* PUBLISH-FIX-83: pending looks visible (item 37) */ })), setCatalystEvent: (symbol, event) => { const c = candidates.get(symbol); if (c) c.catalystEvent = event; }, decisions: () => decisions.slice(), dependenciesAt: (episodeId, decisionTs) => { const p = provenance.get(`${episodeId}|${decisionTs}`); return p ? { ...p } : null; }, funnel: () => ({ ...funnel, refusals: { ...refusals } }), status: () => ({ judgeVersion: JUDGE_VERSION, strategyVersion: decisionStrategyVersion, costModelVersion: COST_MODEL_VERSION, setups, candidates: candidates.size, secondLooksPending: [...candidates.values()].reduce((n, c) => n + c.secondLook.size, 0), bridgeQueueDepth: bridgeQueue.length, counters: { ...counters }, funnel: { ...funnel }, refusals: { ...refusals }, scheduler: S.status(), cache: cache.status(), lastEntryMono, admissionGate: { batches: gate.batches, lastBatch: gate.lastBatch } }), scheduler: S, admissionGate: () => ({ batches: gate.batches, lastBatch: gate.lastBatch }) };
}
