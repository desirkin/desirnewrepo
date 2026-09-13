// FORWARD-SHADOW LANE — strict, pure validation and accounting for hypothetical
// round trips against subsequently observed order-book snapshots. A size label
// (S/M/L), a truthy object, or a candle touch is never execution evidence.
//
// This helper grants no authority and places no order. COMPLETE means only that
// the declared size could be fully walked through two causally aligned, proven-
// continuous observed books under the sealed latency/fee policy. It does not
// claim that an order was submitted or filled.
import { walkBook } from '../lib/book-walk.js';
import {
  canonicalDigest, captureError, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs, round6,
} from './shadow-contracts.js';

export const SHADOW_EXECUTION_EVIDENCE_VERSION = 'shadow-execution-evidence-1';
export const MAX_EXECUTION_BOOK_AGE_MS = 1_000;
export const SOURCE_CLOCK_TOLERANCE_MS = 2_000;

const PATH_KEYS = Object.freeze(['evidenceVersion', 'captureId', 'variantId', 'sizeTier', 'intended', 'entry', 'exit']);
const INTENDED_KEYS = Object.freeze(['quoteNotional', 'baseQty']);
const LEG_KEYS = Object.freeze(['side', 'signalKnownAtTs', 'executionTs', 'snapshot', 'coverage']);
const SNAPSHOT_KEYS = Object.freeze([
  'bids', 'asks', 'receivedTs', 'knownAtTs', 'sourceEventTs', 'epochId',
  'synchronized', 'checksumVerified', 'truncated',
]);
const COVERAGE_KEYS = Object.freeze(['state', 'startTs', 'endTs', 'epochId', 'droppedUpdates']);

const none = (reason) => deepFreeze({
  evidenceVersion: SHADOW_EXECUTION_EVIDENCE_VERSION,
  state: 'NONE',
  reason,
  evidenceDigest: null,
  intended: null,
  entry: null,
  exit: null,
  accounting: null,
  actualFillObserved: false,
});

const positive = (v) => isFiniteNum(v) && v > 0;
const nonNegative = (v) => isFiniteNum(v) && v >= 0;

function validateLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 5_000) return false;
  let previous = null;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2 || !positive(level[0]) || !positive(level[1])) return false;
    if (previous !== null && (side === 'BID' ? level[0] >= previous : level[0] <= previous)) return false;
    previous = level[0];
  }
  return true;
}

function validateLeg(leg, { expectedSide, expectedSignalTs, decisionTs, latencyMs, asOfTs }) {
  if (exactKeys(leg, LEG_KEYS)) return { ok: false, reason: `${expectedSide}_LEG_SCHEMA` };
  if (leg.side !== expectedSide) return { ok: false, reason: `${expectedSide}_SIDE_MISMATCH` };
  if (!isTs(expectedSignalTs) || !isTs(leg.signalKnownAtTs) || leg.signalKnownAtTs !== expectedSignalTs) return { ok: false, reason: `${expectedSide}_SIGNAL_UNALIGNED` };
  if (!isTs(leg.executionTs) || leg.executionTs !== leg.signalKnownAtTs + latencyMs) return { ok: false, reason: `${expectedSide}_LATENCY_UNALIGNED` };
  if (leg.signalKnownAtTs < decisionTs || leg.executionTs > asOfTs) return { ok: false, reason: `${expectedSide}_LOOKAHEAD` };

  const snapshot = leg.snapshot;
  if (exactKeys(snapshot, SNAPSHOT_KEYS)) return { ok: false, reason: `${expectedSide}_SNAPSHOT_SCHEMA` };
  if (snapshot.synchronized !== true || snapshot.checksumVerified !== true || snapshot.truncated !== false) return { ok: false, reason: `${expectedSide}_BOOK_UNVERIFIED` };
  if (typeof snapshot.epochId !== 'string' || snapshot.epochId.length === 0 || snapshot.epochId.length > 120) return { ok: false, reason: `${expectedSide}_EPOCH_MALFORMED` };
  if (!isTs(snapshot.receivedTs) || !isTs(snapshot.knownAtTs) || snapshot.knownAtTs < snapshot.receivedTs
      || snapshot.knownAtTs - snapshot.receivedTs > SOURCE_CLOCK_TOLERANCE_MS) return { ok: false, reason: `${expectedSide}_CLOCK_MALFORMED` };
  if (snapshot.knownAtTs < decisionTs || snapshot.knownAtTs > leg.executionTs || leg.executionTs - snapshot.knownAtTs > MAX_EXECUTION_BOOK_AGE_MS) return { ok: false, reason: `${expectedSide}_BOOK_STALE_OR_FUTURE` };
  if (!isTs(snapshot.sourceEventTs)) return { ok: false, reason: `${expectedSide}_SOURCE_CLOCK_MALFORMED` };
  if (Math.abs(snapshot.sourceEventTs - snapshot.receivedTs) > SOURCE_CLOCK_TOLERANCE_MS) return { ok: false, reason: `${expectedSide}_SOURCE_CLOCK_CONFLICT` };
  if (!validateLevels(snapshot.bids, 'BID') || !validateLevels(snapshot.asks, 'ASK') || snapshot.bids[0][0] >= snapshot.asks[0][0]) return { ok: false, reason: `${expectedSide}_BOOK_MALFORMED` };

  const coverage = leg.coverage;
  if (exactKeys(coverage, COVERAGE_KEYS)) return { ok: false, reason: `${expectedSide}_COVERAGE_SCHEMA` };
  if (coverage.state !== 'CONTINUOUS' || coverage.epochId !== snapshot.epochId || coverage.droppedUpdates !== 0) return { ok: false, reason: `${expectedSide}_COVERAGE_INCOMPLETE` };
  if (!isTs(coverage.startTs) || !isTs(coverage.endTs) || coverage.startTs > snapshot.receivedTs || coverage.endTs < leg.executionTs) return { ok: false, reason: `${expectedSide}_COVERAGE_INCOMPLETE` };
  return { ok: true, leg };
}

// entrySignalTs / exitSignalTs are resolved by the outcome law. Passing null is
// deliberate for an intrabar limit/stop/target whose exact live trigger clock is
// unknowable from candles; such a path cannot be upgraded to execution evidence.
export function evaluateShadowExecutionEvidence({
  capture, costPolicy, depthPath, entrySignalTs, exitSignalTs, asOfTs,
} = {}) {
  try {
    if (captureError(capture) || capture.inputFidelity !== 'DEPTH_SUPPORTED' || !isTs(capture.decisionTs)) return none('CAPTURE_NOT_DEPTH_SUPPORTED');
    if (!isPlainObject(costPolicy) || canonicalDigest(costPolicy) !== canonicalDigest(capture.recipeSeal.recipe.costPolicy) || !nonNegative(costPolicy.feePctPerSide)) return none('COST_POLICY_MISMATCH');
    if (!Number.isSafeInteger(costPolicy.assumedLatencyMs) || costPolicy.assumedLatencyMs < 0) return none('LATENCY_POLICY_UNALIGNABLE');
    if (!isTs(asOfTs)) return none('ASOF_CLOCK_MALFORMED');
    if (!isTs(entrySignalTs)) return none('ENTRY_SIGNAL_TIME_UNAVAILABLE');
    if (!isTs(exitSignalTs)) return none('EXIT_SIGNAL_TIME_UNAVAILABLE');
    if (exactKeys(depthPath, PATH_KEYS)) return none('DEPTH_PATH_SCHEMA');
    if (depthPath.evidenceVersion !== SHADOW_EXECUTION_EVIDENCE_VERSION || depthPath.captureId !== capture.captureId
      || depthPath.variantId !== capture.variantId || depthPath.sizeTier !== capture.variant?.sizeTier) return none('DEPTH_PATH_IDENTITY_MISMATCH');
    if (exactKeys(depthPath.intended, INTENDED_KEYS)) return none('INTENDED_SIZE_SCHEMA');
    const hasQuote = positive(depthPath.intended.quoteNotional);
    const hasBase = positive(depthPath.intended.baseQty);
    if (hasQuote === hasBase || !(depthPath.intended.quoteNotional === null || hasQuote) || !(depthPath.intended.baseQty === null || hasBase)) return none('INTENDED_SIZE_MALFORMED');
    const sealedAllocation = capture.variant.intendedAllocation;
    const intendedMatchesSeal = sealedAllocation.kind === 'QUOTE_NOTIONAL'
      ? hasQuote && depthPath.intended.quoteNotional === sealedAllocation.amount && depthPath.intended.baseQty === null
      : sealedAllocation.kind === 'BASE_QUANTITY'
        ? hasBase && depthPath.intended.baseQty === sealedAllocation.amount && depthPath.intended.quoteNotional === null
        : false;
    if (!intendedMatchesSeal) return none('INTENDED_SIZE_SEAL_MISMATCH');

    const entryCheck = validateLeg(depthPath.entry, { expectedSide: 'BUY', expectedSignalTs: entrySignalTs, decisionTs: capture.decisionTs, latencyMs: costPolicy.assumedLatencyMs, asOfTs });
    if (!entryCheck.ok) return none(entryCheck.reason);
    const exitCheck = validateLeg(depthPath.exit, { expectedSide: 'SELL', expectedSignalTs: exitSignalTs, decisionTs: capture.decisionTs, latencyMs: costPolicy.assumedLatencyMs, asOfTs });
    if (!exitCheck.ok) return none(exitCheck.reason);
    if (depthPath.exit.signalKnownAtTs <= depthPath.entry.executionTs) return none('EXIT_PRECEDES_ENTRY');

    const requested = hasQuote ? { quoteNotional: depthPath.intended.quoteNotional } : { baseQty: depthPath.intended.baseQty };
    const entryWalk = walkBook(depthPath.entry.snapshot.asks, requested);
    if (entryWalk.coverage !== 'FULL' || !positive(entryWalk.filledBase) || !positive(entryWalk.filledQuote) || !positive(entryWalk.averagePrice)) return none('ENTRY_DEPTH_PARTIAL');
    const exitWalk = walkBook(depthPath.exit.snapshot.bids, { baseQty: entryWalk.filledBase });
    if (exitWalk.coverage !== 'FULL' || !positive(exitWalk.filledQuote) || !positive(exitWalk.averagePrice)) return none('EXIT_DEPTH_PARTIAL');

    const entryMid = (depthPath.entry.snapshot.bids[0][0] + depthPath.entry.snapshot.asks[0][0]) / 2;
    const exitMid = (depthPath.exit.snapshot.bids[0][0] + depthPath.exit.snapshot.asks[0][0]) / 2;
    const entrySpread = Math.max(0, (depthPath.entry.snapshot.asks[0][0] - entryMid) * entryWalk.filledBase);
    const exitSpread = Math.max(0, (exitMid - depthPath.exit.snapshot.bids[0][0]) * exitWalk.filledBase);
    const entrySlippage = Math.max(0, (entryWalk.averagePrice - depthPath.entry.snapshot.asks[0][0]) * entryWalk.filledBase);
    const exitSlippage = Math.max(0, (depthPath.exit.snapshot.bids[0][0] - exitWalk.averagePrice) * exitWalk.filledBase);
    const feeFraction = costPolicy.feePctPerSide / 100;
    const fees = entryWalk.filledQuote * feeFraction + exitWalk.filledQuote * feeFraction;
    const grossQuote = exitWalk.filledQuote - entryWalk.filledQuote;
    const netQuote = grossQuote - fees;
    const spreadCostQuote = entrySpread + exitSpread;
    const slippageCostQuote = entrySlippage + exitSlippage;
    const grossPct = 100 * grossQuote / entryWalk.filledQuote;
    const netPct = 100 * netQuote / entryWalk.filledQuote;
    const costsPct = 100 * (fees + spreadCostQuote + slippageCostQuote) / entryWalk.filledQuote;
    if (![fees, grossPct, netPct, costsPct, spreadCostQuote, slippageCostQuote].every(Number.isFinite)) return none('ACCOUNTING_INVALID');

    const evidence = {
      evidenceVersion: SHADOW_EXECUTION_EVIDENCE_VERSION,
      state: 'COMPLETE',
      reason: null,
      evidenceDigest: canonicalDigest(depthPath),
      intended: { ...depthPath.intended },
      entry: {
        signalKnownAtTs: depthPath.entry.signalKnownAtTs,
        executionTs: depthPath.entry.executionTs,
        snapshotKnownAtTs: depthPath.entry.snapshot.knownAtTs,
        epochId: depthPath.entry.snapshot.epochId,
        walk: entryWalk,
      },
      exit: {
        signalKnownAtTs: depthPath.exit.signalKnownAtTs,
        executionTs: depthPath.exit.executionTs,
        snapshotKnownAtTs: depthPath.exit.snapshot.knownAtTs,
        epochId: depthPath.exit.snapshot.epochId,
        walk: exitWalk,
      },
      accounting: {
        averageEntryPrice: round6(entryWalk.averagePrice),
        averageExitPrice: round6(exitWalk.averagePrice),
        entryQuote: round6(entryWalk.filledQuote),
        exitQuote: round6(exitWalk.filledQuote),
        grossQuote: round6(grossQuote),
        roundTripFeesQuote: round6(fees),
        spreadCostQuote: round6(spreadCostQuote),
        slippageCostQuote: round6(slippageCostQuote),
        grossPct: round6(grossPct),
        costsPct: round6(costsPct),
        netPct: round6(netPct),
      },
      actualFillObserved: false,
    };
    return deepFreeze(evidence);
  } catch {
    return none('DEPTH_PATH_REJECTED');
  }
}
