// FORWARD-SHADOW LANE — the adversarial law suite: clock spoofing/backdating, late and future-known inputs,
// restart idempotence, chain tamper evidence, fees/volume/depth missingness, same-moment variant dependence,
// TAKE/ABSTAIN paired outcomes, no lookahead, immutable captures, quota pacing/backpressure/cancel, and the
// explicitly unvalidated prepared result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowStore } from '../learning/shadow-store.js';
import { buildShadowCapture } from '../learning/shadow-capture.js';
import { matureShadowCapture } from '../learning/shadow-outcome.js';
import { createShadowLane } from '../learning/shadow-lane.js';
import { buildShadowResearchResult } from '../learning/shadow-result.js';
import { recipeError } from '../learning/shadow-contracts.js';
import { evaluateShadowExecutionEvidence, SHADOW_EXECUTION_EVIDENCE_VERSION } from '../learning/shadow-execution-evidence.js';

const MIN = 60_000;
const T = Date.UTC(2026, 8, 13, 12, 0, 0); // an aligned minute boundary
const COST = { costPolicyVersion: 'shadow-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 };
const RECIPE = {
  recipeVersion: 'shadow-recipe-test-1',
  styleId: 'MOMENTUM_CONTINUATION',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['SOCIAL_CONTEXT', 'NEWS_CONTEXT'],
  candleWindowMin: 5, candlePeriodMs: MIN, maxInputAgeMs: 2 * MIN, horizonMin: 3, costPolicy: COST,
  variants: [
    { variantId: 'take-open-s', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 1 },
    { variantId: 'take-limit-m', decision: 'TAKE', sizeTier: 'M', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 1000 }, entryRule: 'LIMIT_AT_TRIGGER', limitOffsetBps: 10, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 1 },
    { variantId: 'take-open-l', decision: 'TAKE', sizeTier: 'L', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 2000 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 1 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
};
const candle = (i, { close = 100, vol = 10, known = null, closed = true, tradeFlow = 0.1 } = {}) => ({
  periodStartTs: T - (5 - i) * MIN, periodEndTs: T - (4 - i) * MIN,
  open: close, high: close + 0.2, low: close - 0.2, close,
  volumeBase: vol, volumeQuote: vol * close, closed, knownAtTs: known ?? T - (4 - i) * MIN, tradeFlow,
});
const WINDOW = [0, 1, 2, 3, 4].map((i) => candle(i));
const pathCandle = (i, { open = 100, high = 100.3, low = 99.8, close = 100.1 } = {}) => ({
  periodStartTs: T + i * MIN, periodEndTs: T + (i + 1) * MIN, open, high, low, close,
  volumeBase: 5, closed: true, knownAtTs: T + (i + 1) * MIN + 200,
});
const tdir = () => mkdtempSync(path.join(tmpdir(), 'cobra-shadow-'));

test('the recipe contract holds: candles are mandatory substrate, a TAKE lane carries its ABSTAIN pair, required and contextual inputs are disjoint', () => {
  assert.equal(recipeError(RECIPE), null);
  assert.match(recipeError({ ...RECIPE, requiredInputs: ['VOLUME'] }), /substrate/);
  assert.match(recipeError({ ...RECIPE, variants: RECIPE.variants.filter((v) => v.decision === 'TAKE') }), /ABSTAIN/);
  assert.match(recipeError({ ...RECIPE, contextualInputs: ['VOLUME', 'SOCIAL_CONTEXT'] }), /both required and contextual/);
});

test('capture freezes the then-known world and REFUSES ineligible opportunities with the exact reason — never zeros, never backfill: future-known candles, unclosed candles, missing volume, staleness and window gaps each refuse', () => {
  const ok = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
  assert.equal(ok.eligible.length, 4, 'one capture per predeclared variant');
  assert.equal(ok.ineligible.length, 0);
  const c0 = ok.eligible[0];
  assert.equal(c0.inputFidelity, 'CANDLE_ONLY', 'no depth supplied = an honest downgrade, recorded');
  assert.match(c0.inputDigest, /^[0-9a-f]{64}$/);
  assert.equal(c0.inputWindow.endTs, T, 'the frozen window ends AT the decision clock');
  assert.ok(c0.groupId.startsWith('fsmom-') && c0.groupId !== c0.opportunityId, 'the dependence group is the DECISION MOMENT, distinct from the window-bearing opportunity id');
  assert.ok(ok.eligible.every((x) => x.groupId === c0.groupId), 'every variant of the moment shares the ONE group');
  assert.ok(Object.isFrozen(c0) && Object.isFrozen(c0.frozenFacts), 'captures are immutable');
  assert.ok(new Set(ok.eligible.map((x) => x.captureId)).size === 4 && new Set(ok.eligible.map((x) => x.opportunityId)).size === 1);
  const cases = [
    [{ candles: WINDOW.map((c, i) => (i === 4 ? { ...c, knownAtTs: T + 1 } : c)) }, 'FUTURE_KNOWN_INPUT'],
    [{ candles: WINDOW.map((c, i) => (i === 4 ? { ...c, closed: false } : c)) }, 'CANDLE_NOT_CLOSED'],
    [{ candles: WINDOW.map((c, i) => (i === 2 ? { ...c, volumeBase: undefined, volumeQuote: undefined } : c)) }, 'VOLUME_MISSING'],
    [{ candles: WINDOW.slice(0, 3) }, 'CANDLE_WINDOW_INCOMPLETE'],
    [{ candles: WINDOW.map((c, i) => (i === 3 ? { ...c, periodStartTs: c.periodStartTs - 1, periodEndTs: c.periodEndTs - 1 } : c)) }, 'NON_CONTIGUOUS_WINDOW'],
  ];
  for (const [inputs, reason] of cases) {
    const r = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs });
    assert.equal(r.eligible.length, 0, reason);
    assert.equal(r.ineligible[0].reason, reason);
  }
  // staleness: the same window judged two hours later is stale evidence, not a capture
  const stale = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T + 2 * 60 * MIN, inputs: { candles: WINDOW } });
  assert.equal(stale.ineligible[0].reason, 'REQUIRED_INPUT_STALE');
  // a recipe REQUIRING trade-flow refuses a window without it; the base recipe treats it as contextual
  const needsFlow = { ...RECIPE, requiredInputs: [...RECIPE.requiredInputs, 'TRADE_FLOW'] };
  const noFlow = buildShadowCapture({ recipe: needsFlow, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW.map((c) => ({ ...c, tradeFlow: undefined })) } });
  assert.equal(noFlow.ineligible[0].reason, 'TRADE_FLOW_MISSING');
});

test('the STORE owns time and order: caller-supplied clocks cannot backdate an after-the-fact capture; the digest chain makes every row tamper-evident; a corrupted journal refuses all further appends', () => {
  const dir = tdir();
  try {
    let now = T + 1000; const clock = () => now;
    const store = createShadowStore({ dataDir: dir, clock });
    const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
    assert.equal(store.appendCapture(built.eligible[0]).ok, true, 'a fresh forward capture is accepted');
    // clock spoofing: yesterday's "opportunity" presented as a capture NOW is refused by the STORE clock
    const old = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T - 24 * 60 * MIN, inputs: { candles: WINDOW.map((c) => ({ ...c, periodStartTs: c.periodStartTs - 24 * 60 * MIN, periodEndTs: c.periodEndTs - 24 * 60 * MIN, knownAtTs: c.knownAtTs - 24 * 60 * MIN })) } });
    assert.equal(store.appendCapture(old.eligible[0]).refused, 'LATE_CAPTURE_AFTER_THE_FACT');
    // a decision clock AHEAD of the store clock is not a forward capture either
    const future = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T + 10 * MIN, inputs: { candles: WINDOW.map((c) => ({ ...c, periodStartTs: c.periodStartTs + 10 * MIN, periodEndTs: c.periodEndTs + 10 * MIN, knownAtTs: c.knownAtTs + 10 * MIN })) } });
    assert.equal(store.appendCapture(future.eligible[0]).refused, 'LATE_CAPTURE_AFTER_THE_FACT');
    assert.equal(store.verify().ok, true);
    // tamper: flip a byte inside an appended row — reopen detects it and the journal becomes read-only evidence
    const raw = readFileSync(store.journalFile, 'utf8');
    writeFileSync(store.journalFile, raw.replace('"venue":"kraken"', '"venue":"KRAKEN"'));
    const reopened = createShadowStore({ dataDir: dir, clock });
    assert.equal(reopened.status().chainOk, false);
    assert.match(reopened.status().chainReason, /digest mismatch/);
    assert.equal(reopened.appendCapture(built.eligible[1]).refused, 'CHAIN_CORRUPT', 'no new evidence lands on a tampered chain');
    assert.equal(reopened.verify().ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart idempotence: a reopened store reconstructs the same counts from the journal alone, refuses duplicate captures (no count inflation) and keeps the chain intact', () => {
  const dir = tdir();
  try {
    let now = T + 1000; const clock = () => now;
    const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
    const s1 = createShadowStore({ dataDir: dir, clock });
    for (const rec of built.eligible) assert.equal(s1.appendCapture(rec).ok, true);
    const before = s1.status();
    assert.equal(before.variantCaptures, 4); assert.equal(before.primaryOpportunities, 1, 'variants NEVER inflate the primary count');
    const s2 = createShadowStore({ dataDir: dir, clock });
    const after = s2.status();
    assert.equal(after.variantCaptures, 4); assert.equal(after.primaryOpportunities, 1); assert.equal(after.seq, before.seq);
    assert.equal(s2.appendCapture(built.eligible[0]).refused, 'DUPLICATE_CAPTURE', 'restart does not re-open the door to duplicates');
    assert.equal(s2.verify().ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('NO LOOKAHEAD in maturation: a path candle that precedes the decision, was known at/before the decision, or was known after asOf is refused outright — the future is only ever the SUBSEQUENTLY observed real path', () => {
  const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
  const cap = built.eligible.find((c) => c.variantId === 'take-open-s');
  const good = [0, 1, 2].map((i) => pathCandle(i));
  assert.throws(() => matureShadowCapture({ capture: cap, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [{ ...pathCandle(0), periodStartTs: T - MIN, periodEndTs: T }, ...good], asOfTs: T + 4 * MIN }), /LOOKAHEAD/);
  assert.throws(() => matureShadowCapture({ capture: cap, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [{ ...pathCandle(0), knownAtTs: T }, ...good.slice(1)], asOfTs: T + 4 * MIN }), /SUBSEQUENTLY observed/);
  assert.throws(() => matureShadowCapture({ capture: cap, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: good.map((c) => ({ ...c, knownAtTs: T + 60 * MIN })), asOfTs: T + 4 * MIN }), /future evidence/);
  assert.throws(() => matureShadowCapture({ capture: cap, costPolicy: { ...COST, costPolicyVersion: 'other' }, horizonMin: RECIPE.horizonMin, path: good, asOfTs: T + 4 * MIN }), /SEALED cost policy/);
});

test('PENDING before the horizon; paired TAKE/ABSTAIN accounting after it; a missing or gapped path is UNMATURABLE (missing evidence, never zeros); stop/target in one candle resolves CONSERVATIVELY with the flag', () => {
  const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
  const take = built.eligible.find((c) => c.variantId === 'take-open-s');
  const abstain = built.eligible.find((c) => c.variantId === 'abstain');
  const up = [pathCandle(0), pathCandle(1, { open: 100.1, high: 101.6, low: 100, close: 101.5 }), pathCandle(2, { open: 101.5, high: 101.7, low: 101.2, close: 101.4 })];
  const early = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [up[0]], asOfTs: T + MIN + 300 });
  assert.equal(early.label, 'PENDING_BEFORE_HORIZON', 'no outcome is claimed before the horizon closes');
  const t = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: up, asOfTs: T + 4 * MIN });
  assert.equal(t.label, 'MATURED_FAVORABLE', JSON.stringify(t));
  assert.equal(t.exit.kind, 'TARGET');
  assert.ok(t.netPct < t.grossPct + 1e-9 && t.netPct > 0, `fees and assumed spread reduce the outcome (net ${t.netPct} vs gross ${t.grossPct})`);
  assert.ok(t.ambiguityFlags.includes('ENTRY_FILL_ASSUMED_AT_CANDLE_FIDELITY') && t.ambiguityFlags.includes('PARTIAL_FILL_UNKNOWABLE_AT_CANDLE_FIDELITY'), 'every candle-fidelity assumption is a recorded flag');
  const a = matureShadowCapture({ capture: abstain, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: up, asOfTs: T + 4 * MIN });
  assert.equal(a.label, 'MATURED_NEUTRAL'); assert.equal(a.netPct, 0); assert.equal(a.groupId, t.groupId, 'the pair shares the dependence group');
  assert.equal(t.pairedVsAbstainPct, t.netPct, 'the paired difference is explicit');
  // both stop and target inside ONE candle: conservative stop-first, flagged, never an optimistic pick
  const wild = [pathCandle(0, { open: 100, high: 101.6, low: 98.5, close: 99 }), pathCandle(1, { open: 99, high: 99.2, low: 98.8, close: 99 }), pathCandle(2, { open: 99, high: 99.2, low: 98.8, close: 99 })];
  const amb = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: wild, asOfTs: T + 4 * MIN });
  assert.equal(amb.exit.kind, 'STOP');
  assert.ok(amb.ambiguityFlags.includes('STOP_TARGET_SAME_CANDLE_CONSERVATIVE_STOP_FIRST'));
  assert.ok(amb.netPct < 0);
  // a hole in the observed path is missing evidence
  const gapped = matureShadowCapture({ capture: take, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: [up[0], up[2]], asOfTs: T + 4 * MIN });
  assert.equal(gapped.label, 'UNMATURABLE_PATH_MISSING');
});

test('fidelity honesty: candle-only outcomes can NEVER carry size evidence and a truthy depth marker cannot mint it', () => {
  const built = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } });
  const bigTake = built.eligible.find((c) => c.variantId === 'take-open-l');
  const up = [pathCandle(0), pathCandle(1, { open: 100.1, high: 101.6, low: 100, close: 101.5 }), pathCandle(2, { open: 101.5, high: 101.7, low: 101.2, close: 101.4 })];
  const o = matureShadowCapture({ capture: bigTake, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: up, asOfTs: T + 4 * MIN });
  assert.equal(o.fidelity, 'CANDLE_ONLY');
  assert.equal(o.sizeEvidence, 'NONE_AT_CANDLE_FIDELITY', 'an L-tier variant at candle fidelity mints NO size evidence');
  const withDepth = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW, depth: { bids: [[99.9, 5]], asks: [[100.1, 5]], knownAtTs: T - 500 } } });
  assert.equal(withDepth.eligible[0].inputFidelity, 'DEPTH_SUPPORTED');
  const od = matureShadowCapture({ capture: withDepth.eligible.find((c) => c.variantId === 'take-open-s'), costPolicy: COST, horizonMin: RECIPE.horizonMin, path: up, asOfTs: T + 4 * MIN, depthPath: { observed: true } });
  assert.equal(od.fidelity, 'CANDLE_ONLY');
  assert.equal(od.sizeEvidence, 'NONE_AT_CANDLE_FIDELITY', 'a mere truthy marker is not a book, a size, or an observed fill');
});

test('strict shadow execution evidence requires actual intended size, two complete book walks, continuous clocks and exact latency alignment', () => {
  const withDepth = buildShadowCapture({ recipe: RECIPE, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW, depth: { bids: [[99.9, 5]], asks: [[100.1, 5]], knownAtTs: T - 500 } } });
  const capture = withDepth.eligible.find((c) => c.variantId === 'take-open-s');
  const point = (side, signalKnownAtTs, { epochId = `epoch-${side.toLowerCase()}`, snapshot = {}, coverage = {} } = {}) => ({
    side, signalKnownAtTs, executionTs: signalKnownAtTs + COST.assumedLatencyMs,
    snapshot: {
      bids: side === 'BUY' ? [[99.9, 10], [99.8, 10]] : [[101, 10], [100.9, 10]],
      asks: side === 'BUY' ? [[100.1, 5], [100.2, 10]] : [[101.2, 10], [101.3, 10]],
      receivedTs: signalKnownAtTs + 100, knownAtTs: signalKnownAtTs + 200,
      sourceEventTs: signalKnownAtTs + 50, epochId,
      synchronized: true, checksumVerified: true, truncated: false,
      ...snapshot,
    },
    coverage: {
      state: 'CONTINUOUS', startTs: signalKnownAtTs - 1_000, endTs: signalKnownAtTs + 600,
      epochId, droppedUpdates: 0,
      ...coverage,
    },
  });
  const validPath = {
    evidenceVersion: SHADOW_EXECUTION_EVIDENCE_VERSION,
    captureId: capture.captureId,
    variantId: capture.variantId, sizeTier: capture.variant.sizeTier,
    intended: { quoteNotional: 600, baseQty: null },
    entry: point('BUY', T), exit: point('SELL', T + 3 * MIN),
  };
  const args = { capture, costPolicy: COST, entrySignalTs: T, exitSignalTs: T + 3 * MIN, asOfTs: T + 4 * MIN };
  const valid = evaluateShadowExecutionEvidence({ ...args, depthPath: validPath });
  assert.equal(valid.state, 'COMPLETE', valid.reason);
  assert.equal(valid.actualFillObserved, false, 'a depth walk is hypothetical execution against observed levels, not an actual fill');
  assert.equal(valid.entry.walk.coverage, 'FULL'); assert.equal(valid.exit.walk.coverage, 'FULL');
  assert.ok(valid.accounting.averageEntryPrice > validPath.entry.snapshot.asks[0][0], 'multi-level buy walk records slippage beyond touch');
  assert.ok(valid.accounting.roundTripFeesQuote > 0 && valid.accounting.spreadCostQuote > 0 && valid.accounting.slippageCostQuote > 0);

  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: { observed: true } }).state, 'NONE');
  const hugeRecipe = { ...RECIPE, recipeVersion: 'shadow-recipe-huge-depth-1', variants: RECIPE.variants.map((v) => v.variantId === 'take-open-s' ? { ...v, intendedAllocation: { ...v.intendedAllocation, amount: 1_000_000 } } : v) };
  const hugeCapture = buildShadowCapture({ recipe: hugeRecipe, venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW, depth: { bids: [[99.9, 5]], asks: [[100.1, 5]], knownAtTs: T - 500 } } }).eligible.find((c) => c.variantId === 'take-open-s');
  const partial = { ...validPath, captureId: hugeCapture.captureId, variantId: hugeCapture.variantId, sizeTier: hugeCapture.variant.sizeTier, intended: { quoteNotional: 1_000_000, baseQty: null } };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, capture: hugeCapture, depthPath: partial }).reason, 'ENTRY_DEPTH_PARTIAL');
  const ambiguousSize = { ...validPath, intended: { quoteNotional: 600, baseQty: 5 } };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: ambiguousSize }).reason, 'INTENDED_SIZE_MALFORMED');
  const wrongTier = { ...validPath, sizeTier: 'L' };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: wrongTier }).reason, 'DEPTH_PATH_IDENTITY_MISMATCH');
  const futureClock = { ...validPath, entry: point('BUY', T, { snapshot: { knownAtTs: T + 501 } }) };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: futureClock }).reason, 'BUY_BOOK_STALE_OR_FUTURE');
  const missingSourceClock = { ...validPath, entry: point('BUY', T, { snapshot: { sourceEventTs: null } }) };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: missingSourceClock }).reason, 'BUY_SOURCE_CLOCK_MALFORMED');
  const staleSourceClock = { ...validPath, entry: point('BUY', T, { snapshot: { sourceEventTs: T - 60_000 } }) };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: staleSourceClock }).reason, 'BUY_SOURCE_CLOCK_CONFLICT');
  const delayedRelabel = { ...validPath, entry: point('BUY', T, { snapshot: { receivedTs: T - 60_000, sourceEventTs: T - 60_000 } }) };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: delayedRelabel }).reason, 'BUY_CLOCK_MALFORMED');
  const gapped = { ...validPath, exit: point('SELL', T + 3 * MIN, { coverage: { droppedUpdates: 1 } }) };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: gapped }).reason, 'SELL_COVERAGE_INCOMPLETE');
  const latencyMismatch = { ...validPath, entry: { ...validPath.entry, executionTs: T + COST.assumedLatencyMs + 1 } };
  assert.equal(evaluateShadowExecutionEvidence({ ...args, depthPath: latencyMismatch }).reason, 'BUY_LATENCY_UNALIGNED');

  const flat = [pathCandle(0), pathCandle(1), pathCandle(2)];
  const depthOutcome = matureShadowCapture({ capture, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: flat, asOfTs: T + 4 * MIN, depthPath: validPath });
  assert.equal(depthOutcome.fidelity, 'DEPTH_SUPPORTED');
  assert.equal(depthOutcome.sizeEvidence, 'DEPTH_SUPPORTED_OBSERVED');
  assert.equal(depthOutcome.entry.executionEvidence.actualFillObserved, false);
  assert.equal(depthOutcome.exit.ts, T + 3 * MIN + COST.assumedLatencyMs, 'sealed latency changes the aligned hypothetical execution clock');
  const candleOutcome = matureShadowCapture({ capture, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: flat, asOfTs: T + 4 * MIN, depthPath: { observed: true } });
  assert.equal(candleOutcome.sizeEvidence, 'NONE_AT_CANDLE_FIDELITY');
  assert.notEqual(depthOutcome.pathDigest, candleOutcome.pathDigest, 'the digest binds execution evidence whenever it changes the accounting');

  const limitCapture = withDepth.eligible.find((c) => c.variantId === 'take-limit-m');
  const limitPath = { ...validPath, captureId: limitCapture.captureId, variantId: limitCapture.variantId, sizeTier: limitCapture.variant.sizeTier };
  const limitOutcome = matureShadowCapture({ capture: limitCapture, costPolicy: COST, horizonMin: RECIPE.horizonMin, path: flat, asOfTs: T + 4 * MIN, depthPath: limitPath });
  assert.equal(limitOutcome.sizeEvidence, 'NONE_AT_CANDLE_FIDELITY', 'a candle-derived intrabar limit clock cannot be upgraded');
});

test('the LANE paces and never inflates: bounded batches, dedupe, daily-target and durable-quota backpressure recorded as SHED (never silently dropped), stop() halts, and the status separates captured/pending/matured/ineligible against the target', () => {
  const dir = tdir();
  try {
    let now = T + 1000; let mono = 0;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    const lane = createShadowLane({ store, recipe: RECIPE, quotas: { dailyEvaluationTarget: 10, maxBatch: 2, minInterBatchMs: 10 }, clock: () => now, monotonic: () => mono });
    const opp = (assetId, offsetMin = 0) => ({ venue: 'kraken', assetId, decisionTs: T + offsetMin * MIN, inputs: { candles: WINDOW.map((c) => ({ ...c, periodStartTs: c.periodStartTs + offsetMin * MIN, periodEndTs: c.periodEndTs + offsetMin * MIN, knownAtTs: c.knownAtTs + offsetMin * MIN })) } });
    const r1 = lane.runBatch({ opportunities: [opp('BTC'), opp('ETH'), opp('SOL')], nowTs: now });
    assert.equal(r1.captured, 8, 'two opportunities x four variants inside the batch bound');
    assert.equal(r1.shed, 1, 'the third opportunity is SHED by the batch bound — recorded, not dropped silently');
    assert.equal(r1.quota, 'BATCH_BOUND');
    mono += 5; // pacing floor: an immediate second batch is refused, honestly
    assert.equal(lane.runBatch({ opportunities: [opp('SOL')], nowTs: now }).quota, 'PACING_MIN_INTERVAL');
    mono += 50;
    const r2 = lane.runBatch({ opportunities: [opp('BTC'), opp('SOL')], nowTs: now });
    assert.equal(r2.deduped, 4, 'a re-presented opportunity is DEDUPED, never recounted');
    assert.equal(r2.captured, 2, 'the target (10) binds at VARIANT granularity: only two SOL variants fit');
    assert.equal(r2.shed, 2, 'the remaining SOL variants are SHED, recorded');
    assert.equal(r2.quota, 'DAILY_TARGET_REACHED');
    const st = lane.status(now);
    assert.equal(st.evaluationsToday, 10, 'EXACTLY the daily target, never beyond');
    assert.equal(st.journal.primaryOpportunities, 3);
    assert.match(st.targetLaw, /NOT_AN_EDGE_CLAIM/);
    // stop() halts everything between items
    lane.stop();
    assert.equal(lane.runBatch({ opportunities: [opp('ADA')], nowTs: now }).stopped, true);
    lane.resume();
    // durable-quota backpressure on a fresh lane with a 1-byte budget
    const dir2 = tdir();
    try {
      const store2 = createShadowStore({ dataDir: dir2, clock: () => now });
      let m2 = 0;
      const tiny = createShadowLane({ store: store2, recipe: RECIPE, quotas: { maxDurableBytesPerDay: 1, minInterBatchMs: 1 }, clock: () => now, monotonic: () => (m2 += 10) });
      const first = tiny.runBatch({ opportunities: [opp('BTC')], nowTs: now });
      assert.equal(first.captured, 1, 'the very first append lands; the byte quota then binds at VARIANT granularity');
      assert.equal(first.quota, 'BACKPRESSURE_DURABLE_QUOTA');
      assert.equal(first.shed, 3, 'the remaining variants are SHED and recorded, never silently dropped');
      const second = tiny.runBatch({ opportunities: [opp('ETH')], nowTs: now });
      assert.equal(second.quota, 'BACKPRESSURE_DURABLE_QUOTA');
      assert.equal(second.captured, 0); assert.ok(second.shed >= 1);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('maturation through the lane + the prepared result: PENDING first, matured after the horizon, and the result is EXPLICITLY UNVALIDATED with authority NONE — unpaired groups contribute nothing, counts are never an edge claim', () => {
  const dir = tdir();
  try {
    let now = T + 1000; let mono = 0;
    const store = createShadowStore({ dataDir: dir, clock: () => now });
    const lane = createShadowLane({ store, recipe: RECIPE, quotas: { minInterBatchMs: 1 }, clock: () => now, monotonic: () => (mono += 100) });
    lane.runBatch({ opportunities: [{ venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles: WINDOW } }], nowTs: now });
    const up = [pathCandle(0), pathCandle(1, { open: 100.1, high: 101.6, low: 100, close: 101.5 }), pathCandle(2, { open: 101.5, high: 101.7, low: 101.2, close: 101.4 })];
    const caps = [...store.captures().values()];
    const paths = Object.fromEntries(caps.map((c) => [c.captureId, { candles: up }]));
    now = T + MIN + 500;
    // only the candles OBSERVED SO FAR may ride a pending-round path (a later-known candle is future evidence)
    const observedSoFar = Object.fromEntries(caps.map((c) => [c.captureId, { candles: [up[0]] }]));
    const pendingRound = lane.matureBatch({ paths: observedSoFar, asOfTs: now });
    assert.equal(pendingRound.pending, caps.length, 'before the horizon everything is PENDING');
    now = T + 5 * MIN;
    const maturedRound = lane.matureBatch({ paths, asOfTs: now });
    assert.equal(maturedRound.matured, caps.length, 'after the horizon each capture matures ONCE');
    const again = lane.matureBatch({ paths, asOfTs: now });
    assert.equal(again.matured, 0, 'a terminal outcome is never re-recorded');
    const result = buildShadowResearchResult({ store, recipeVersion: RECIPE.recipeVersion, asOfTs: now });
    assert.equal(result.state, 'UNVALIDATED_RESEARCH_RESULT');
    assert.equal(result.authority, 'NONE');
    assert.equal(result.pairedGroups, 1, 'one opportunity = one paired dependence group');
    assert.ok(result.disclaimers.some((d) => d.startsWith('NOT_VALIDATED')) && result.disclaimers.some((d) => d.startsWith('COUNT_IS_NOT_EDGE')));
    assert.equal(result.sizeEvidence, 'NONE_AT_CANDLE_FIDELITY');
    assert.ok(Number.isFinite(result.meanPairedTakeMinusAbstainPct));
    const s = lane.status(now);
    assert.equal(s.journal.maturedOutcomes, caps.length); assert.equal(s.journal.pendingOutcomes, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SEPARATION fences: shadow modules import only shadow siblings + lib/jsonl.js, carry no network primitive, no order/ledger/Judge/Watch token, and never import the campaign, prospective, promotion or execution paths', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // fileURLToPath: portable on Windows
  const files = ['learning/shadow-contracts.js', 'learning/shadow-store.js', 'learning/shadow-capture.js', 'learning/shadow-outcome.js', 'learning/shadow-lane.js', 'learning/shadow-result.js'];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const imp = m[1];
      const allowed = imp.startsWith('./shadow-') || imp === '../lib/jsonl.js' || imp.startsWith('node:crypto') || imp.startsWith('node:fs') || imp === 'node:path' || imp === 'node:os';
      assert.ok(allowed, `${f} imports ${imp} — the shadow lane is self-contained`);
    }
    for (const bad of ['ORDER_INTENT', 'RESERVATION_OPENED', 'POSITION_OPENED', "from '../execution", "from '../judge", "from '../watch", "from './campaign.js'", "from './prospective.js'", "from './promotion.js'", 'node:http', 'node:net', 'WebSocket', 'fetch(']) {
      assert.ok(!src.includes(bad), `${f} carries forbidden token ${bad}`);
    }
  }
});
