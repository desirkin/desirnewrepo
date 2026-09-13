// FORWARD-SHADOW LANE — maturation against the SUBSEQUENTLY OBSERVED real market path. Never a fabricated
// future: the path is the real candles that closed after the decision, each carrying its own knownAt clock, and
// a candle known at-or-before the decision (or overlapping it) is refused as lookahead. Before the horizon the
// label is PENDING_BEFORE_HORIZON; a matured label carries the full round-trip accounting under the capture's
// SEALED cost policy (fees both sides, assumed half-spread and latency at candle fidelity — every assumption is
// an explicit flag, never silent). Stop/target ambiguity inside one candle resolves CONSERVATIVELY (stop first)
// and is flagged. Candle-only fidelity can never mint size evidence.
import {
  SHADOW_OUTCOME_VERSION, LANE, AUTHORITY, PURPOSE,
  outcomeError, canonicalDigest, deepFreeze, isPlainObject, isTs, isFiniteNum, captureError, recipeSealError, round6,
} from './shadow-contracts.js';
import { evaluateShadowExecutionEvidence } from './shadow-execution-evidence.js';

const MINUTE = 60_000;

// capture: a stored capture record; costPolicy + horizonMin: the recipe terms the capture sealed (cost policy
// matched by version; the horizon is part of the frozen recipe, passed through explicitly, never re-decided);
// path: [{ periodStartTs, periodEndTs, open, high, low, close, volumeBase?, closed, knownAtTs }] observed AFTER
// the decision; asOfTs: the maturation clock; depthPath: optional observed depth (fidelity upgrade evidence).
export function matureShadowCapture({ capture, costPolicy: suppliedCostPolicy = null, horizonMin: suppliedHorizonMin = null, path, asOfTs, depthPath = null }) {
  const captureErr = captureError(capture); if (captureErr) throw new Error(`shadow outcome: capture invalid (${captureErr})`);
  const sealErr = recipeSealError(capture.recipeSeal); if (sealErr) throw new Error(`shadow outcome: ${sealErr}`);
  const costPolicy = capture.recipeSeal.recipe.costPolicy;
  const horizonMin = capture.recipeSeal.recipe.horizonMin;
  if (suppliedCostPolicy !== null && canonicalDigest(suppliedCostPolicy) !== canonicalDigest(costPolicy)) throw new Error('shadow outcome: supplied cost policy does not match the SEALED cost policy in the capture recipe');
  if (suppliedHorizonMin !== null && suppliedHorizonMin !== horizonMin) throw new Error('shadow outcome: supplied horizon does not match the SEALED capture recipe');
  if (!isTs(asOfTs)) throw new Error('shadow outcome: asOf clock required');
  const D = capture.decisionTs;
  if (asOfTs < D) throw new Error('shadow outcome: asOf clock precedes the captured decision');

  const base = (label, extra) => {
    const record = {
      outcomeVersion: SHADOW_OUTCOME_VERSION,
      captureId: capture.captureId, opportunityId: capture.opportunityId, variantId: capture.variantId, groupId: capture.groupId, lane: LANE,
      label, asOfTs, horizonEndTs: extra.horizonEndTs,
      entry: extra.entry ?? null, exit: extra.exit ?? null,
      grossPct: extra.grossPct ?? null, costsPct: extra.costsPct ?? null, netPct: extra.netPct ?? null,
      pairedVsAbstainPct: extra.pairedVsAbstainPct ?? null,
      ambiguityFlags: extra.ambiguityFlags ?? [],
      fidelity: extra.fidelity, sizeEvidence: extra.sizeEvidence,
      pathDigest: extra.pathDigest ?? canonicalDigest({ empty: true }),
      authority: AUTHORITY, purpose: PURPOSE,
    };
    const err = outcomeError(record); if (err) throw new Error(`shadow outcome: built an invalid record (${err})`);
    return deepFreeze(record);
  };

  // THE ALIGNED-BAR HORIZON LAW (review P0, second pass): candle data cannot answer sub-bar questions, so the
  // horizon is PREDECLARED as a whole number of declared bars after the decision boundary — never a raw
  // millisecond offset. A decision at :00.200 gets bars [:01 .. :01+H): every bar used ENDS at or before the
  // declared boundary, so no partial bar can leak seconds of post-horizon high/low/close into the outcome.
  const period = capture.inputUnits?.candlePeriodMs;
  if (!isFiniteNum(period) || period <= 0) throw new Error('shadow outcome: the capture must carry its frozen bar granularity');
  if ((horizonMin * MINUTE) % period !== 0) throw new Error('shadow outcome: the sealed horizon must be a WHOLE number of declared bars');
  const bound = Math.ceil(D / period) * period;
  const horizonEnd = bound + horizonMin * MINUTE; // the DECLARED aligned boundary; recorded on every outcome
  // observed-path law: every candle must be one DECLARED bar, STARTED at/after the decision boundary, CLOSED,
  // and known AFTER the decision (a path row known at/before D is lookahead or a re-labelled input)
  const candles = Array.isArray(path) ? [...path].sort((a, b) => a.periodStartTs - b.periodStartTs) : [];
  for (const c of candles) {
    if (!isPlainObject(c) || !isTs(c.periodStartTs) || !isTs(c.periodEndTs) || c.closed !== true) throw new Error('shadow outcome: path candle malformed or not closed');
    if (c.periodEndTs - c.periodStartTs !== period) throw new Error('shadow outcome: a path candle must be one DECLARED bar — mixed granularity is not a path');
    if (c.periodStartTs < D) throw new Error(`shadow outcome: LOOKAHEAD refused — path candle starting ${c.periodStartTs} precedes the decision ${D}`);
    if (!isTs(c.knownAtTs) || c.knownAtTs <= D) throw new Error(`shadow outcome: path candle known at ${c.knownAtTs} was not SUBSEQUENTLY observed`);
    if (c.knownAtTs < c.periodEndTs) throw new Error('shadow outcome: a candle cannot be known before it closes');
    if (c.knownAtTs > asOfTs) throw new Error('shadow outcome: a path candle known after asOf is future evidence for THIS maturation');
    for (const f of ['open', 'high', 'low', 'close']) if (!isFiniteNum(c[f]) || c[f] <= 0) throw new Error('shadow outcome: path candle prices malformed');
  }
  let pathDigest = canonicalDigest({ captureId: capture.captureId, candles });
  // Depth cannot be credited before a complete, size-specific entry AND exit
  // walk is validated below. Pending, abstain, missing-path and rejected-depth
  // outcomes remain candle-descriptive even if the capture saw a book at D.
  let fidelity = 'CANDLE_ONLY';
  let sizeEvidence = 'NONE_AT_CANDLE_FIDELITY';

  // ABSTAIN: the paired baseline — no position, no costs, nothing tied up
  if (capture.variant.decision === 'ABSTAIN') {
    if (asOfTs < horizonEnd) return base('PENDING_BEFORE_HORIZON', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
    return base('MATURED_NEUTRAL', { horizonEndTs: horizonEnd, grossPct: 0, costsPct: 0, netPct: 0, pairedVsAbstainPct: 0, fidelity, sizeEvidence, pathDigest });
  }

  if (asOfTs < horizonEnd) return base('PENDING_BEFORE_HORIZON', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
  // the usable path: ONLY whole bars ENDING at or before the declared boundary (a bar ending after it is the
  // future, whatever its start), beginning exactly at the decision boundary and CONTIGUOUS from there — the
  // first hole ends the usable span; nothing after a hole may inform this outcome
  const started = candles.filter((c) => c.periodEndTs <= horizonEnd);
  if (started.length === 0) return base('UNMATURABLE_PATH_MISSING', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
  if (started[0].periodStartTs !== bound) return base('UNMATURABLE_PATH_MISSING', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
  const inHorizon = [started[0]];
  for (let i = 1; i < started.length; i += 1) { if (started[i].periodStartTs !== started[i - 1].periodEndTs) break; inHorizon.push(started[i]); }
  // COVERAGE-THROUGH-HORIZON LAW (review P0): the observed span must reach the declared boundary before ANY
  // claim that depends on "nothing happened for the rest of the horizon" — a shorter span can still mature
  // ONLY through an exit that genuinely occurred inside it; it can never pretend a horizon outcome
  const coverageEndTs = inHorizon[inHorizon.length - 1].periodEndTs;
  const coversHorizon = coverageEndTs >= horizonEnd;

  const v = capture.variant;
  const flags = new Set(['LATENCY_ASSUMED_NOT_OBSERVED', 'SPREAD_ASSUMED_NOT_OBSERVED']);
  const halfSpread = costPolicy.assumedHalfSpreadBps / 10_000;
  // entry under the frozen rule, on the REAL subsequent candles only
  let entryPrice = null; let entryIdx = null; let entrySignalTs = null;
  if (v.entryRule === 'NEXT_CANDLE_OPEN') {
    entryPrice = inHorizon[0].open * (1 + halfSpread);
    entryIdx = 0; entrySignalTs = inHorizon[0].periodStartTs; flags.add('ENTRY_FILL_ASSUMED_AT_CANDLE_FIDELITY');
  } else { // LIMIT_AT_TRIGGER below the frozen last close
    const limit = capture.frozenFacts.lastClose * (1 - (v.limitOffsetBps ?? 0) / 10_000);
    for (let i = 0; i < inHorizon.length; i += 1) {
      if (inHorizon[i].low <= limit) { entryPrice = limit; entryIdx = i; flags.add('ENTRY_FILL_ASSUMED_AT_CANDLE_FIDELITY'); break; }
    }
    if (entryPrice === null) {
      // "the limit never traded" is a claim about the WHOLE horizon: without coverage through horizonEnd the
      // limit may have filled inside the unobserved tail — missing evidence, never a pretended non-entry
      if (!coversHorizon) return base('UNMATURABLE_PATH_MISSING', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
      return base('MATURED_NEUTRAL', { horizonEndTs: horizonEnd, grossPct: 0, costsPct: 0, netPct: 0, pairedVsAbstainPct: 0, entry: { rule: v.entryRule, filled: false, price: null }, ambiguityFlags: [...flags], fidelity, sizeEvidence, pathDigest });
    }
  }
  flags.add('PARTIAL_FILL_UNKNOWABLE_AT_CANDLE_FIDELITY');

  const stop = entryPrice * (1 - v.stopPct / 100);
  const target = entryPrice * (1 + v.targetPct / 100);
  let exit = null; const ambiguity = [];
  for (let i = entryIdx; i < inHorizon.length && !exit; i += 1) {
    const c = inHorizon[i];
    const hitStop = c.low <= stop; const hitTarget = c.high >= target;
    if (hitStop && hitTarget) { ambiguity.push('STOP_TARGET_SAME_CANDLE_CONSERVATIVE_STOP_FIRST'); exit = { kind: 'STOP', price: stop, ts: c.periodEndTs }; }
    else if (hitStop) exit = { kind: 'STOP', price: stop, ts: c.periodEndTs };
    else if (hitTarget) exit = { kind: 'TARGET', price: target, ts: c.periodEndTs };
  }
  // a stop/target exit found inside the observed span genuinely happened; a HORIZON outcome is a claim about
  // the ENTIRE horizon and requires the span to reach horizonEnd — a truncated tail is missing evidence
  if (!exit && !coversHorizon) return base('UNMATURABLE_PATH_MISSING', { horizonEndTs: horizonEnd, fidelity, sizeEvidence, pathDigest });
  if (!exit) exit = { kind: 'HORIZON', price: inHorizon[inHorizon.length - 1].close, ts: inHorizon[inHorizon.length - 1].periodEndTs };

  // A candle discloses no exact intrabar limit/stop/target trigger clock, so
  // those cases cannot align a latency-adjusted book without lookahead. The
  // only safe upgrade here is an exact next-bar-open entry and horizon exit.
  const depthExecution = evaluateShadowExecutionEvidence({
    capture, costPolicy, depthPath,
    entrySignalTs,
    exitSignalTs: exit.kind === 'HORIZON' ? exit.ts : null,
    asOfTs,
  });
  // Re-evaluate the stop/target geometry from the actual depth-walk average
  // entry. If that changes the candle path to an intrabar exit, its exact clock
  // is unknowable and the execution upgrade is refused.
  const depthEntry = depthExecution.state === 'COMPLETE' ? depthExecution.accounting.averageEntryPrice : null;
  const depthStop = depthEntry === null ? null : depthEntry * (1 - v.stopPct / 100);
  const depthTarget = depthEntry === null ? null : depthEntry * (1 + v.targetPct / 100);
  const depthHasIntrabarExit = depthEntry !== null && inHorizon.some((c) => c.low <= depthStop || c.high >= depthTarget);

  let exitPrice; let grossPct; let costsPct; let netPct; let entryRecord; let exitRecord;
  if (depthExecution.state === 'COMPLETE' && !depthHasIntrabarExit) {
    fidelity = 'DEPTH_SUPPORTED'; sizeEvidence = 'DEPTH_SUPPORTED_OBSERVED';
    flags.clear();
    entryPrice = depthExecution.accounting.averageEntryPrice;
    exitPrice = depthExecution.accounting.averageExitPrice;
    grossPct = depthExecution.accounting.grossPct;
    costsPct = depthExecution.accounting.costsPct;
    netPct = depthExecution.accounting.netPct;
    entryRecord = {
      rule: v.entryRule, filled: true, price: entryPrice,
      executionEvidence: { kind: 'HYPOTHETICAL_OBSERVED_DEPTH_WALK', actualFillObserved: false, ...depthExecution.entry },
    };
    exitRecord = {
      kind: exit.kind, price: exitPrice, ts: depthExecution.exit.executionTs,
      executionEvidence: { kind: 'HYPOTHETICAL_OBSERVED_DEPTH_WALK', actualFillObserved: false, ...depthExecution.exit },
    };
    pathDigest = canonicalDigest({ captureId: capture.captureId, candles, executionEvidenceDigest: depthExecution.evidenceDigest });
  } else {
    exitPrice = exit.price * (1 - halfSpread);
    grossPct = round6((exitPrice / entryPrice - 1) * 100);
    costsPct = round6(2 * costPolicy.feePctPerSide + 2 * (costPolicy.assumedHalfSpreadBps / 100));
    // the half-spread already rode the fill prices; costsPct DISCLOSES it beside the fees rather than deducting twice
    netPct = round6((exitPrice * (1 - costPolicy.feePctPerSide / 100)) / (entryPrice * (1 + costPolicy.feePctPerSide / 100)) * 100 - 100);
    entryRecord = { rule: v.entryRule, filled: true, price: round6(entryPrice) };
    exitRecord = { kind: exit.kind, price: round6(exitPrice), ts: exit.ts };
  }
  const label = netPct > 0.05 ? 'MATURED_FAVORABLE' : netPct < -0.05 ? 'MATURED_ADVERSE' : ambiguity.length ? 'MATURED_AMBIGUOUS' : 'MATURED_NEUTRAL';
  return base(label, {
    horizonEndTs: horizonEnd,
    entry: entryRecord,
    exit: exitRecord,
    grossPct, costsPct, netPct, pairedVsAbstainPct: netPct,
    ambiguityFlags: [...flags, ...ambiguity],
    fidelity, sizeEvidence, pathDigest,
  });
}
