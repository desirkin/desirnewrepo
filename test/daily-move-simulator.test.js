// SIM-1 (2026-09-15): the daily-move simulator drives a pure price-geometry detector over the study's prefix-only
// decision frames, fires at most once per case, scores the forward bite separately, and splits firing across surges vs
// controls — without mutating the zero-credit study. No network, no model, deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateDailyMoves, priceGeometryBreakoutDetector, DAILY_MOVE_SIMULATOR_VERSION } from '../learning/daily-move-simulator.js';
import { buildDailyMoveStudy, sealDailyMoveStudyManifest, SUPPORT_FAMILIES } from '../learning/daily-move-study.js';
import { sealAcceptedCatalogSnapshot, marketIdentityDigest } from '../learning/shadow-catalog-snapshot.js';
import { sealShadowRecipe } from '../learning/shadow-recipe-seal.js';

const MIN = 60_000;
const B = Date.UTC(2026, 8, 13, 6); // some intraday base
// a 1-minute closed candle i (close chosen by caller); known just after it ends
const mkCandle = (i, close, open = close) => ({ observationId: `c${i}`, periodStartTs: B + i * MIN, periodEndTs: B + (i + 1) * MIN, open, high: Math.max(open, close), low: Math.min(open, close), close, volumeBase: 1, volumeQuote: 100, closed: true, receivedTs: B + (i + 1) * MIN + 5, knownAtTs: B + (i + 1) * MIN + 5, sourceDigest: 'd'.repeat(64) });
const frame = (min) => ({ decisionTs: B + min * MIN, observedClosedCandles: 0, observedPriceEvents: 0 });

test('SIM-U1. the detector fires on a >8% fresh-high prefix and abstains on a flat one; first fire wins; the bite scores separately', () => {
  // surge: closes 100..110 over minutes 0..10 (a 10% ordered rise), then 112..120 forward for the bite
  const surgeCandles = [];
  for (let i = 0; i <= 5; i += 1) surgeCandles.push(mkCandle(i, 100 + i * 2)); // closes 100,102,...,110 (periodEnd <= B+6min)
  for (let i = 6; i <= 12; i += 1) surgeCandles.push(mkCandle(i, 110 + (i - 5) * 2, 110 + (i - 5) * 2)); // forward 112..124
  const flatCandles = []; for (let i = 0; i <= 12; i += 1) flatCandles.push(mkCandle(i, 100));
  const study = {
    manifest: { manifestId: 'm-test' },
    cases: [
      { caseId: 'surge', marketIdentityDigest: 'dS', retrospectiveLabels: { disposition: 'SURGE_CASE' }, retrospectiveReplay: { decisionFrames: [frame(7), frame(8)] } },
      { caseId: 'flat', marketIdentityDigest: 'dF', retrospectiveLabels: { disposition: 'FLAT_CONTROL' }, retrospectiveReplay: { decisionFrames: [frame(7)] } },
      { caseId: 'noframes', marketIdentityDigest: 'dX', retrospectiveLabels: { disposition: 'OTHER_OBSERVED' }, retrospectiveReplay: { decisionFrames: [] } },
    ],
  };
  const marketDays = [{ marketIdentityDigest: 'dS', candles: surgeCandles }, { marketIdentityDigest: 'dF', candles: flatCandles }];
  const r = simulateDailyMoves({ study, marketDays, horizonMs: 5 * MIN });
  assert.equal(r.simulatorVersion, DAILY_MOVE_SIMULATOR_VERSION); assert.equal(r.authority, 'NONE');
  const surge = r.cases.find((c) => c.caseId === 'surge'); const flat = r.cases.find((c) => c.caseId === 'flat');
  assert.equal(surge.fired, true, 'the >8% fresh-high prefix fires'); assert.equal(surge.firedAtTs, B + 7 * MIN, 'the first frame fires');
  assert.equal(surge.bite.state, 'KNOWN'); assert.ok(surge.bite.logReturnPct > 0, 'the surge bite is a positive log return');
  assert.equal(flat.fired, false, 'the flat prefix never fires'); assert.equal('bite' in flat, false);
  assert.equal(r.cases.some((c) => c.caseId === 'noframes'), false, 'a case with no decision frames is not simulated');
  assert.equal(r.counters.attemptedSimulations, 2); assert.equal(r.counters.firedSimulations, 1); assert.equal(r.counters.validSimulationOutcomes, 1);
  assert.equal(r.confusion.firedByDisposition.SURGE_CASE, 1); assert.equal(r.confusion.firedByDisposition.FLAT_CONTROL ?? 0, 0);
  assert.equal(r.confusion.casesByDisposition.OTHER_OBSERVED, 1, 'the no-frame case is still counted in the cohort');
});

test('SIM-U2. the detector honours the decision clock: a rise that only completes AFTER the last frame does not fire; a missing forward horizon is NOT_YET_KNOWN', () => {
  // closes flat 100 through minute 8, then the >8% rise only lands at minutes 9-10 (after the frame at minute 8)
  const candles = []; for (let i = 0; i <= 8; i += 1) candles.push(mkCandle(i, 100)); candles.push(mkCandle(9, 112)); candles.push(mkCandle(10, 115));
  const late = { manifest: { manifestId: 'm' }, cases: [{ caseId: 'late', marketIdentityDigest: 'dL', retrospectiveLabels: { disposition: 'SURGE_CASE' }, retrospectiveReplay: { decisionFrames: [frame(5), frame(8)] } }] };
  const r = simulateDailyMoves({ study: late, marketDays: [{ marketIdentityDigest: 'dL', candles }], horizonMs: 5 * MIN });
  assert.equal(r.cases[0].fired, false, 'the rise is not known by any decision frame, so no fire');

  // fires late (minute 10 frame) but no forward candles cover the 5m horizon -> NOT_YET_KNOWN
  const candles2 = []; for (let i = 0; i <= 5; i += 1) candles2.push(mkCandle(i, 100 + i * 2)); // 100..110 by minute 6
  const r2 = simulateDailyMoves({ study: { manifest: { manifestId: 'm' }, cases: [{ caseId: 'edge', marketIdentityDigest: 'dE', retrospectiveLabels: { disposition: 'SURGE_CASE' }, retrospectiveReplay: { decisionFrames: [frame(7)] } }] }, marketDays: [{ marketIdentityDigest: 'dE', candles: candles2 }], horizonMs: 5 * MIN });
  assert.equal(r2.cases[0].fired, true); assert.equal(r2.cases[0].bite.state, 'OUTCOME_UNAVAILABLE', 'no post-decision entry candle => honest unavailable'); assert.equal(r2.counters.validSimulationOutcomes, 0);
});

test('SIM-U3. the detector params are recorded; a custom detector and bad input are handled', () => {
  const det = priceGeometryBreakoutDetector({ riseThresholdPct: 20 });
  assert.equal(det.id, 'PRICE_GEOMETRY_BREAKOUT'); assert.deepEqual(det.params, { riseThresholdPct: 20 });
  const candles = []; for (let i = 0; i <= 6; i += 1) candles.push(mkCandle(i, 100 + i * 2)); // 10% rise
  const r = simulateDailyMoves({ study: { manifest: { manifestId: 'm' }, cases: [{ caseId: 's', marketIdentityDigest: 'd', retrospectiveLabels: { disposition: 'SURGE_CASE' }, retrospectiveReplay: { decisionFrames: [frame(7)] } }] }, marketDays: [{ marketIdentityDigest: 'd', candles }], detector: det });
  assert.equal(r.cases[0].fired, false, 'a 10% rise does not clear a 20% threshold'); assert.equal(r.detector.params.riseThresholdPct, 20);
  assert.throws(() => simulateDailyMoves({ study: null, marketDays: [] }), /built daily-move study/);
  assert.throws(() => simulateDailyMoves({ study: { cases: [] }, marketDays: [], detector: 'x' }), /detector must be a function/);
});

// ---- integration through the real study builder --------------------------------------------------------------------
const HOUR = 60 * 60_000;
const DAY_START = Date.UTC(2026, 8, 13, 4); // ET midnight
const DAY_END = DAY_START + 24 * HOUR;
const mkt = (n) => { const coin = `C${String(n).padStart(4, '0')}`; return { subjectKind: 'MARKET', canonicalCoin: coin, providerAssetId: `${coin}USD`, venue: 'kraken', nativeSymbol: `${coin}/USD`, base: coin, quote: 'USD', marketType: 'SPOT', quoteAliasGroup: 'USD' }; };
const catalog = sealAcceptedCatalogSnapshot({ observedTs: DAY_START, knownAtTs: DAY_START + 1, maxAgeMs: 24 * HOUR, markets: [mkt(0), mkt(1)] });
const recipeSeal = sealShadowRecipe({ recipeVersion: 'daily-study-recipe-1', styleId: 'MOMENTUM_CONTINUATION', requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['TRADE_FLOW'], candleWindowMin: 5, candlePeriodMs: 60_000, maxInputAgeMs: 120_000, horizonMin: 5, costPolicy: { costPolicyVersion: 'c1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 }, variants: [{ variantId: 'take', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 2 }, { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null }] });
const manifest = sealDailyMoveStudyManifest({ createdTs: DAY_END + HOUR, localDay: '2026-09-13', dayStartTs: DAY_START, dayEndTs: DAY_END, acceptedCatalogSnapshot: catalog, recipeSeals: [recipeSeal] });
const SUP = 'e'.repeat(64);
const hourCandle = (id, h, close, open = close) => ({ observationId: id, periodStartTs: DAY_START + h * HOUR, periodEndTs: DAY_START + (h + 1) * HOUR, open, high: Math.max(open, close), low: Math.min(open, close), close, volumeBase: 1, volumeQuote: 100, closed: true, receivedTs: DAY_START + (h + 1) * HOUR + 10, knownAtTs: DAY_START + (h + 1) * HOUR + 20, sourceDigest: SUP });
const miss = () => ({ state: 'MISSING', observedCount: 0, coverageStartTs: null, coverageEndTs: null, gapCount: 0, sourceDigests: [], reason: 'NOT_RECORDED' });
const part = (count) => ({ state: 'PARTIAL', observedCount: count, coverageStartTs: DAY_START + HOUR, coverageEndTs: DAY_END - HOUR, gapCount: 0, sourceDigests: [SUP], reason: 'PARTIAL_DAY' });
const supportOf = (candles) => { const out = Object.fromEntries(SUPPORT_FAMILIES.map((f) => [f, miss()])); out.CANDLES = part(candles.length); out.BASE_VOLUME = part(candles.filter((c) => c.volumeBase !== null).length); out.QUOTE_VOLUME = part(candles.filter((c) => c.volumeQuote !== null).length); return out; };
const dayOf = (n, candles) => ({ marketIdentityDigest: marketIdentityDigest(mkt(n)), priceEvents: [], candles, support: supportOf(candles) });

test('SIM-I1. through the real study: a >8% surge day is classified SURGE_CASE, gets decision frames, and the simulator fires on it while the flat control does not', () => {
  // C0000: an ordered rise 100 -> 111 across hours 1..3 (>8%). C0001: flat 100 (a FLAT_CONTROL).
  const surge = dayOf(0, [hourCandle('s1', 1, 100), hourCandle('s2', 2, 106), hourCandle('s3', 3, 111)]);
  const flat = dayOf(1, [hourCandle('f1', 1, 100), hourCandle('f2', 2, 100), hourCandle('f3', 3, 100)]);
  const study = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [surge, flat] });
  const surgeCase = study.cases.find((c) => c.market.canonicalCoin === 'C0000');
  assert.equal(surgeCase.retrospectiveLabels.disposition, 'SURGE_CASE');
  assert.ok(surgeCase.retrospectiveReplay.decisionFrames.length > 0, 'the surge gets materialized decision frames');
  // the study leaves its own simulation counters zero-credit (SIM-1 never changes that)
  assert.equal(study.counters.attemptedSimulations, 0);

  const r = simulateDailyMoves({ study, marketDays: [surge, flat], detector: priceGeometryBreakoutDetector({ riseThresholdPct: 8 }), horizonMs: 2 * HOUR });
  const simSurge = r.cases.find((c) => c.caseId === surgeCase.caseId);
  assert.ok(simSurge, 'the surge case is simulated'); assert.equal(simSurge.fired, true, 'the detector fires on the >8% surge prefix');
  assert.ok(r.counters.firedSimulations >= 1); assert.equal(r.confusion.firedByDisposition.SURGE_CASE >= 1, true);
});
