import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyDecisionFrame, buildDailyMoveStudy, sealDailyMoveStudyManifest, sealDailyMoveStudyManifestV3,
  dailyMoveStudyManifestError, DAILY_MOVE_MANIFEST_VERSION_V3, SUPPORT_FAMILIES,
} from '../learning/daily-move-study.js';
import { sealAcceptedCatalogSnapshot, marketIdentityDigest } from '../learning/shadow-catalog-snapshot.js';
import { sealShadowRecipe } from '../learning/shadow-recipe-seal.js';

const HOUR = 60 * 60_000;
const START = Date.UTC(2026, 8, 13, 4); // midnight America/New_York (EDT)
const END = START + 24 * HOUR;
const CREATED = END + HOUR;
const SOURCE = 'a'.repeat(64);
const market = (n) => {
  const coin = `C${String(n).padStart(4, '0')}`;
  return { subjectKind: 'MARKET', canonicalCoin: coin, providerAssetId: `${coin}USD`, venue: 'kraken', nativeSymbol: `${coin}/USD`, base: coin, quote: 'USD', marketType: 'SPOT', quoteAliasGroup: 'USD' };
};
const catalog = sealAcceptedCatalogSnapshot({ observedTs: START, knownAtTs: START + 1, maxAgeMs: 24 * HOUR, markets: Array.from({ length: 612 }, (_, i) => market(i)) });
const recipeSeal = sealShadowRecipe({
  recipeVersion: 'daily-study-recipe-1', styleId: 'MOMENTUM_CONTINUATION',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: ['TRADE_FLOW', 'DEPTH_SNAPSHOT', 'SOCIAL_CONTEXT', 'NEWS_CONTEXT'],
  candleWindowMin: 5, candlePeriodMs: 60_000, maxInputAgeMs: 120_000, horizonMin: 5,
  costPolicy: { costPolicyVersion: 'daily-study-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 },
  variants: [
    { variantId: 'take-600', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 2 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
});
const manifest = sealDailyMoveStudyManifest({
  createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
  acceptedCatalogSnapshot: catalog, recipeSeals: [recipeSeal],
});

const missing = (reason = 'NOT_RECORDED') => ({ state: 'MISSING', observedCount: 0, coverageStartTs: null, coverageEndTs: null, gapCount: 0, sourceDigests: [], reason });
const complete = (count, digest = SOURCE) => ({ state: 'COMPLETE', observedCount: count, coverageStartTs: START, coverageEndTs: END, gapCount: 0, sourceDigests: [digest], reason: null });
const partial = (count, digest = SOURCE) => ({ state: 'PARTIAL', observedCount: count, coverageStartTs: START + HOUR, coverageEndTs: END - HOUR, gapCount: 0, sourceDigests: [digest], reason: 'PARTIAL_DAY' });
const supportOf = ({ events = [], candles = [], detail = {} } = {}) => {
  const out = Object.fromEntries(SUPPORT_FAMILIES.map((family) => [family, missing()]));
  out.PRICE = events.length ? complete(events.length) : missing();
  out.CANDLES = candles.length ? partial(candles.length) : missing();
  const base = candles.filter((c) => c.volumeBase !== null).length;
  const quote = candles.filter((c) => c.volumeQuote !== null).length;
  out.BASE_VOLUME = base ? partial(base) : missing(); out.QUOTE_VOLUME = quote ? partial(quote) : missing();
  for (const [family, row] of Object.entries(detail)) out[family] = row;
  return out;
};
const event = (id, hours, price) => ({ observationId: id, kind: 'TICKER_UPDATE', price, sourceEventTs: START + hours * HOUR, receivedTs: START + hours * HOUR + 10, knownAtTs: START + hours * HOUR + 20, sourceDigest: SOURCE });
const candle = (id, startHour, { open = 100, high = 100, low = 100, close = 100, volumeBase = 1, volumeQuote = 100 } = {}) => ({
  observationId: id, periodStartTs: START + startHour * HOUR, periodEndTs: START + (startHour + 1) * HOUR,
  open, high, low, close, volumeBase, volumeQuote, closed: true,
  receivedTs: START + (startHour + 1) * HOUR + 10, knownAtTs: START + (startHour + 1) * HOUR + 20, sourceDigest: SOURCE,
});
const day = (n, { events = [], candles = [], detail = {} } = {}) => ({ marketIdentityDigest: marketIdentityDigest(market(n)), priceEvents: events, candles, support: supportOf({ events, candles, detail }) });
const disposition = (report, n) => report.cases.find((c) => c.market.canonicalCoin === market(n).canonicalCoin).retrospectiveLabels.disposition;

test('the retrospective manifest seals the New York civil day, full catalog denominator, recipe variants and strict >8% law', () => {
  assert.equal(manifest.timeZone, 'America/New_York');
  assert.equal(manifest.analysisBasis, 'RETROSPECTIVE_COHORT_STUDY');
  assert.equal(manifest.catalogSnapshot.acceptedMarketCount, 612);
  assert.equal(manifest.catalogProvenance.provenanceVerified, false);
  assert.equal(manifest.catalogProvenance.durableFullDayEpochUnionVerified, false);
  assert.equal(manifest.recipeSeals[0].recipeDigest, recipeSeal.recipeDigest);
  assert.throws(() => sealDailyMoveStudyManifest({ createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START + HOUR, dayEndTs: END + HOUR, acceptedCatalogSnapshot: catalog }), /exactly the declared local day/);
  const changedAlias = sealShadowRecipe({ ...recipeSeal.recipe, costPolicy: { ...recipeSeal.recipe.costPolicy, feePctPerSide: 0.2 } });
  assert.throws(() => sealDailyMoveStudyManifest({ createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END, acceptedCatalogSnapshot: catalog, recipeSeals: [recipeSeal, changedAlias] }), /one recipeVersion/);
  assert.throws(() => sealDailyMoveStudyManifest({ createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END, acceptedCatalogSnapshot: catalog, recipeSeals: Array(65).fill(recipeSeal) }), /exceed 64/);
});

test('all 612 accepted markets remain visible: >8.01 then collapse qualifies, exactly 8 does not, and never-buy/missing cases are retained', () => {
  const surge = day(0, { events: [event('s0', 1, 100), event('s1', 2, 100), event('s2', 3, 108.01), event('s3', 3.2, 90)] });
  const exactEight = day(1, { events: [event('e0', 1, 100), event('e1', 2, 108)] });
  const failed = day(2, { events: [event('f0', 1, 100), event('f1', 2, 100), event('f2', 4, 105), event('f3', 5, 99)] });
  const falling = day(3, { events: [event('d0', 1, 100), event('d1', 2, 100), event('d2', 4, 90)] });
  const flat = day(4, { events: [event('q0', 1, 100), event('q1', 2, 100), event('q2', 4, 100.5), event('q3', 5, 99.5)] });
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [surge, exactEight, failed, falling, flat] });
  assert.equal(report.cases.length, 612);
  assert.equal(report.counters.acceptedMarketDays, 612);
  assert.equal(report.counters.exclusiveDispositionRows, 612);
  assert.equal(disposition(report, 0), 'SURGE_CASE');
  assert.notEqual(disposition(report, 1), 'SURGE_CASE', 'the threshold is strict, so exactly 8.00% is not selected');
  const case0 = report.cases.find((c) => c.market.canonicalCoin === 'C0000');
  assert.ok(case0.retrospectiveLabels.bestOrderedRise.movePct > 8);
  assert.equal(case0.retrospectiveLabels.chronology.phases.peakAndReversal.priceMin, 90, 'the immediate collapse remains in post-breach chronology');
  assert.equal(case0.retrospectiveLabels.chronology.peakIsDescriptiveNotExit, true);
  assert.equal(report.counters.dispositions.MISSING_DATA, 607, 'unobserved and never-selected markets remain explicit denominator rows');
  assert.equal(report.counters.attemptedSimulations, 0); assert.equal(report.counters.completedSimulations, 0); assert.equal(report.counters.validSimulationOutcomes, 0);
  assert.ok(report.counters.grossPlannedRecipeVariantSlots > 0);
  assert.equal(report.counters.inputEligibleSimulationSlots, null);
  assert.equal(report.counters.statisticallyIndependentEvidenceGroups, null);
});

test('same-candle extrema never invent order; a low in a completed earlier bar and a high in a later bar can prove the rise', () => {
  const sameBar = day(5, { candles: [candle('a0', 1, { open: 100, low: 100, high: 109, close: 101 })] });
  const crossBar = day(6, { candles: [
    candle('x0', 1, { open: 100, low: 100, high: 100, close: 100 }),
    candle('x1', 2, { open: 101, low: 101, high: 108.01, close: 102 }),
  ] });
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [sameBar, crossBar] });
  assert.equal(disposition(report, 5), 'AMBIGUOUS_INTRABAR');
  assert.equal(disposition(report, 6), 'SURGE_CASE');
  const wideButUnordered = day(7, { candles: [candle('u0', 1, { open: 100, low: 100, high: 107, close: 101 })] });
  wideButUnordered.support.CANDLES = complete(1);
  const wideReport = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [wideButUnordered] });
  assert.notEqual(disposition(wideReport, 7), 'FLAT_CONTROL', 'a 7% same-bar global range is not flat merely because chronological extrema order is unknown');
});

test('failed-breakout, falling and flat controls are matched only from prefix facts; missing matches stay missing', () => {
  const surgeA = day(10, { events: [event('sa0', 2, 100), event('sa1', 2.5, 100), event('sa2', 3, 109), event('sa3', 4, 95)] });
  const surgeB = day(11, { events: [event('sb0', 2, 100), event('sb1', 2.5, 100), event('sb2', 3, 109), event('sb3', 4, 94)] });
  const failed = day(12, { events: [event('fa0', 2, 100), event('fa1', 2.5, 100), event('fa2', 4, 105), event('fa3', 5, 99)] });
  const falling = day(13, { events: [event('fo0', 2, 100), event('fo1', 2.5, 100), event('fo2', 4, 90)] });
  const flat = day(14, { events: [event('fl0', 2, 100), event('fl1', 2.5, 100), event('fl2', 4, 100.2)] });
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [surgeA, surgeB, failed, falling, flat] });
  assert.equal(disposition(report, 12), 'FAILED_BREAKOUT_CONTROL');
  assert.equal(disposition(report, 13), 'FALLING_CONTROL');
  assert.equal(disposition(report, 14), 'FLAT_CONTROL');
  const surges = report.cases.filter((c) => ['C0010', 'C0011'].includes(c.market.canonicalCoin));
  const matched = surges.find((c) => c.matches.length === 3); const unmatched = surges.find((c) => c.matches.length === 0);
  assert.deepEqual(new Set(matched.matches.map((m) => m.controlClass)), new Set(['FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL']));
  assert.ok(unmatched, 'a control is not silently reused as another independent match');
  assert.equal(report.counters.missingControlMatches, 3);
});

test('detail support is evidence-driven rather than coin-hardcoded, and retrospective labels cannot poison a prior decision frame', () => {
  const baseEvents = [event('p0', 1, 100), event('p1', 2, 101), event('p2', 3, 110)];
  const detailed = day(20, { events: baseEvents, detail: { DEPTH: complete(0, 'd'.repeat(64)), TRADES: complete(0, 'e'.repeat(64)) } });
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [detailed] });
  const row = report.cases.find((c) => c.market.canonicalCoin === 'C0020');
  assert.equal(row.support.DEPTH.state, 'COMPLETE');
  assert.equal(row.support.TRADES.observedCount, 0, 'a coverage-proven zero-trade interval is not an invented trade');

  const before = buildDailyDecisionFrame({ manifest, marketDay: detailed, decisionTs: START + 2.5 * HOUR });
  const changedFuture = structuredClone(detailed); changedFuture.priceEvents[2].price = 1_000_000;
  const after = buildDailyDecisionFrame({ manifest, marketDay: changedFuture, decisionTs: START + 2.5 * HOUR });
  assert.equal(before.prefixDigest, after.prefixDigest);
  assert.equal(before.retrospectiveLabelsIncluded, false);
  assert.equal(before.promotionEligible, false);
  assert.match(before.analysisBasis, /RETROSPECTIVE_REPLAY/);
  changedFuture.priceEvents[1].price = 99;
  const changedPast = buildDailyDecisionFrame({ manifest, marketDay: changedFuture, decisionTs: START + 2.5 * HOUR });
  assert.notEqual(before.prefixDigest, changedPast.prefixDigest);
  const malformed = structuredClone(detailed); malformed.support.PRICE.observedCount += 1;
  assert.throws(() => buildDailyDecisionFrame({ manifest, marketDay: malformed, decisionTs: START + 2.5 * HOUR }), /invalid market day/);
});

test('future-known, duplicate and unaccepted inputs fail closed without shrinking the catalog denominator', () => {
  const bad = day(30, { events: [event('bad', 1, 100)] }); bad.priceEvents[0].knownAtTs = CREATED + 1;
  const duplicate = structuredClone(day(31, { events: [event('dup', 1, 100), event('dup2', 2, 110)] }));
  const outsider = { ...day(32), marketIdentityDigest: 'f'.repeat(64) };
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [bad, duplicate, duplicate, outsider] });
  assert.equal(report.cases.length, 612);
  assert.equal(disposition(report, 30), 'INVALID_DATA');
  assert.equal(disposition(report, 31), 'INVALID_DATA');
  assert.equal(report.counters.unacceptedInputCount, 1);
});

test('a plain-object but incomplete support matrix becomes one non-credit INVALID_DATA row instead of crashing', () => {
  const malformed = day(40, { events: [event('m0', 1, 100)] });
  malformed.support = {};
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [malformed] });
  const row = report.cases.find((c) => c.market.canonicalCoin === 'C0040');
  assert.equal(report.cases.length, 612);
  assert.equal(row.retrospectiveLabels.disposition, 'INVALID_DATA');
  assert.ok(SUPPORT_FAMILIES.every((family) => row.support[family].state === 'MISSING'));
  assert.ok(SUPPORT_FAMILIES.every((family) => row.support[family].reason === 'MARKET_DAY_INPUT_INVALID'));
  assert.equal(report.counters.completeSupportMatrixCases, 0);
});

test('invalid observations cannot earn complete-support credit from a complete-looking matrix', () => {
  const invalid = day(41, { events: [event('future', 1, 100)] });
  invalid.priceEvents[0].knownAtTs = CREATED + 1;
  invalid.support = Object.fromEntries(SUPPORT_FAMILIES.map((family) => [family, complete(0, family.charAt(0).toLowerCase().repeat(64))]));
  const report = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [invalid] });
  const row = report.cases.find((c) => c.market.canonicalCoin === 'C0041');
  assert.equal(row.retrospectiveLabels.disposition, 'INVALID_DATA');
  assert.ok(SUPPORT_FAMILIES.every((family) => row.support[family].state === 'MISSING'));
  assert.equal(report.counters.completeSupportMatrixCases, 0);
});

// L-1: the v3 manifest pins topMoversPerDay to 30 (the same way every version pins the rise
// threshold to 8), and the study widens the population to the union of the >8% threshold cohort
// and the top-30 |close/open-1| movers, deduped, marking the additive members TOP_MOVER_CASE.
const v2Provenance = (catalogSnapshot) => ({
  provenanceVersion: 'daily-broad-archive-provenance-1', state: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY',
  provenanceVerified: true, durableFullDayEpochUnionVerified: true,
  sourceDatasetVersion: 'broad-day-dataset-v1', sourceDatasetDigest: 'b'.repeat(64), sourceDatasetId: `bdd-${'b'.repeat(64)}`,
  sourceArchiveVersion: 'broad-day-archive-local-v2', catalogEpochDigest: 'c'.repeat(64),
  catalogUnionContentDigest: catalogSnapshot.contentDigest, durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
  warning: 'test fixture: content-bound local v2 archive provenance',
});
const sealV3 = (rules = {}) => sealDailyMoveStudyManifestV3({
  createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
  acceptedCatalogSnapshot: catalog, catalogProvenance: v2Provenance(catalog), recipeSeals: [recipeSeal], rules,
});

test('L-1: v3 pins topMoversPerDay to exactly 30 and v1/v2 reject the extra rule key', () => {
  const m = sealV3();
  assert.equal(m.manifestVersion, DAILY_MOVE_MANIFEST_VERSION_V3);
  assert.equal(m.rules.topMoversPerDay, 30);
  assert.equal(m.rules.riseThresholdPct, 8, 'the >8% threshold law is unchanged');
  assert.equal(dailyMoveStudyManifestError(m), null);
  // exactly 30, the same way v2 pins 8: any other value is refused (both directions), whatever the config asks.
  assert.throws(() => sealV3({ topMoversPerDay: 29 }), /topMoversPerDay to 30/);
  assert.throws(() => sealV3({ topMoversPerDay: 31 }), /topMoversPerDay to 30/);
  assert.throws(() => sealV3({ topMoversPerDay: 8 }), /topMoversPerDay to 30/);
  assert.throws(() => sealV3({ topMoversPerDay: 30.5 }), /topMoversPerDay to 30/);
  // a forged v3 whose rule is tampered after the seal still fails the validator.
  const forged = JSON.parse(JSON.stringify(sealV3())); forged.rules.topMoversPerDay = 40;
  assert.match(dailyMoveStudyManifestError(forged), /topMoversPerDay to 30|content identity forged/);
  // v1/v2 carry no topMoversPerDay rule at all — the exact-keys law rejects it.
  assert.throws(() => sealDailyMoveStudyManifest({
    createdTs: CREATED, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: catalog, recipeSeals: [recipeSeal], rules: { topMoversPerDay: 30 },
  }), /rules/);
});

test('L-1: the widened selection unions the >8% cohort with the top movers, deduped — a surge stays SURGE_CASE, a sub-threshold top mover becomes TOP_MOVER_CASE with its own frames', () => {
  const surge = day(0, { events: [event('s0', 1, 100), event('s1', 2, 100), event('s2', 3, 108.01), event('s3', 3.2, 90)] }); // ~10% move, strictly-ordered >8% rise
  const modest = day(30, { events: [event('m0', 1, 100), event('m1', 2, 105)] }); // 5% move: a real mover, below the intraday threshold
  const m3 = sealV3();
  const report = buildDailyMoveStudy({ manifest: m3, acceptedCatalogSnapshot: catalog, marketDays: [surge, modest] });
  assert.equal(disposition(report, 0), 'SURGE_CASE', 'a top mover already in the threshold cohort keeps its disposition (dedup)');
  assert.equal(disposition(report, 30), 'TOP_MOVER_CASE', 'a top-30 mover that did not cross the threshold is the additive selection');
  assert.equal(report.counters.dispositions.TOP_MOVER_CASE, 1);
  const mover = report.cases.find((c) => c.market.canonicalCoin === market(30).canonicalCoin);
  assert.ok(mover.retrospectiveReplay.decisionFrames.length > 0, 'a TOP_MOVER_CASE is a real selected case with decision frames, not a bare denominator row');
  assert.ok(mover.retrospectiveReplay.decisionFrames.every((frame) => frame.knownAtCeilingTs <= frame.decisionTs), 'frames stay strictly decision-time prefixes');
  assert.match(report.laws.topMoverSelection, /TOP 30 MARKETS BY \|CLOSE\/OPEN-1\|/);
  // the SAME market days under v1 never produce a TOP_MOVER_CASE — the widening is v3-only, byte-identical otherwise.
  const v1 = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: catalog, marketDays: [surge, modest] });
  assert.equal(disposition(v1, 0), 'SURGE_CASE');
  assert.equal(disposition(v1, 30), 'OTHER_OBSERVED', 'v1 leaves a sub-threshold mover as OTHER_OBSERVED');
  assert.equal(v1.counters.dispositions.TOP_MOVER_CASE, 0);
  assert.equal(v1.laws.topMoverSelection, undefined, 'v1 carries no top-mover selection law');
});
