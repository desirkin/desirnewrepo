import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGE_LEARNING_FEATURE_RECIPE,
  JUDGE_LEARNING_FEATURE_RECIPE_DIGEST,
  JUDGE_LEARNING_RECIPE_VERSION,
  JUDGE_LEARNING_EFFECT_UNITS,
  JUDGE_LEARNING_MAX_RAW_TRADES,
  buildJudgeLearningPreparedFacts,
  judgeLearningPreparedFactsError,
  judgeLearningPreparedFactsDigestOf,
  judgeLearningFeatureRecipeDigestOf,
  judgeLearningFeatureRecipeError,
  buildJudgeLearningConsumerContract,
  judgeLearningConsumerContractError,
} from '../judge/learning-recipe.js';
import { digestOf } from '../execution/contract.js';
import { FEATURE_VERSION, indicatorBlock } from '../judge/features.js';
import { createExecutionFeed, FEED_DEFAULTS } from '../execution/feed.js';
import { COST_MODEL_VERSION } from '../judge/cost.js';
import { RISK_VERSION } from '../judge/risk.js';
import { STRATEGY_VERSION } from '../judge/setups.js';

const D = 1_789_300_800_000; // exact minute
const POLICY_DIGEST = 'a'.repeat(64);
const clone = (v) => JSON.parse(JSON.stringify(v));
const contract = (over = {}) => buildJudgeLearningConsumerContract({
  policyDigest: POLICY_DIGEST,
  eligibility: {
    maxSpreadBps: 10,
    minBidDepthUsd10bps: 10_000,
    minAtrPct: 0.1,
    maxAtrPct: 2,
    maxFactAgeMs: 120_000,
    requiredFeatures: ['spreadBps', 'atrPct', 'fi60', 'bidDepthUsd10bps', 'rv60', 'fi15'],
    ...(over.eligibility ?? {}),
  },
  effectMagnitude: over.effectMagnitude ?? 0.05,
  activationLifetimeMs: over.activationLifetimeMs ?? 30 * 86_400_000,
  degradeRule: over.degradeRule ?? { minGroups: 8, adverseFractionAbove: 0.6, consecutiveWindows: 2 },
});
const barsEnding = (endTs) => Array.from({ length: 61 }, (_, i) => ({
  periodStartTs: endTs - (61 - i) * 60_000,
  periodEndTs: endTs - (60 - i) * 60_000,
  open: 100, high: 100.5, low: 99.5, close: 100, volumeQuote: 1_000, volumeBase: 10, closed: true,
}));
const snapshotAt = (receiptTs) => {
  const snapshot = {
    snapshotVersion: 'execution-book-snapshot-1', symbol: 'XBT/USD', canonicalCoin: 'BTC', feedEpoch: 7, receiptSequence: 99,
    nativeSequence: null, sourceTs: receiptTs, receiptTs, crc: 1, crcVerified: true, crcComputed: 1, synced: true,
    instrumentDigest: 'c'.repeat(64), priceDecimals: 2, qtyDecimals: 8,
    bids: [['99.95', '250'], ['99.5', '100']], asks: [['100.05', '250'], ['100.5', '100']], levelsCap: 100, truncated: false, kind: 'UPDATE', digest: 'x'.repeat(64),
  };
  snapshot.digest = digestOf({ ...snapshot, digest: null });
  return snapshot;
};
const rawTrade = ({ eventTs, side, quoteNotional, receiptSequence }) => ({
  tradeVersion: 'execution-trade-1', symbol: 'XBT/USD', canonicalCoin: 'BTC', feedEpoch: 7, receiptSequence,
  nativeTradeId: `tr-${receiptSequence}`, side, price: '100', qty: String(quoteNotional / 100), quoteNotional: String(quoteNotional),
  eventTs, receiptTs: eventTs + 1, fromSubscriptionSnapshot: false, orderType: 'market',
});
const tradeWindowAt = (decisionTs, coverageOver = {}) => {
  const trades = []; let receiptSequence = 1;
  for (let k = 20; k >= 1; k -= 1) {
    const start = decisionTs - (k + 1) * 60_000;
    trades.push(rawTrade({ eventTs: start + 20_000, side: 'buy', quoteNotional: 50, receiptSequence: receiptSequence++ }));
    trades.push(rawTrade({ eventTs: start + 40_000, side: 'sell', quoteNotional: 50, receiptSequence: receiptSequence++ }));
  }
  trades.push(rawTrade({ eventTs: decisionTs - 50_000, side: 'buy', quoteNotional: 75, receiptSequence: receiptSequence++ }));
  trades.push(rawTrade({ eventTs: decisionTs - 30_000, side: 'sell', quoteNotional: 75, receiptSequence: receiptSequence++ }));
  trades.push(rawTrade({ eventTs: decisionTs - 10_000, side: 'buy', quoteNotional: 62.5, receiptSequence: receiptSequence++ }));
  trades.push(rawTrade({ eventTs: decisionTs - 5_000, side: 'sell', quoteNotional: 37.5, receiptSequence: receiptSequence++ }));
  return { coverage: { continuous: true, epoch: 7, startTs: decisionTs - 22 * 60_000, endTs: decisionTs, gapTs: null, ...coverageOver }, trades };
};
const inputs = (over = {}) => {
  const decisionTs = over.decisionTs ?? D;
  const referenceTs = over.referenceTs ?? decisionTs - 60_000;
  const bars = barsEnding(referenceTs); const ind = indicatorBlock(bars, { referenceTs: decisionTs });
  const frozen = { atr14: String(ind.atr14), referenceTs, blockDigest: ind.blockDigest, strategyVersion: STRATEGY_VERSION, triggerTs: decisionTs - 500, ...(over.frozen ?? {}) };
  return {
    decisionTs,
    frozen,
    bookSnapshot: over.bookSnapshot === undefined ? snapshotAt(decisionTs - (over.bookAgeMs ?? 250)) : over.bookSnapshot,
    barEvidence: over.barEvidence === undefined ? { featureVersion: FEATURE_VERSION, symbol: 'XBT/USD', canonicalCoin: 'BTC', bars, knownAtTs: bars.map((b) => b.periodEndTs + 10) } : over.barEvidence,
    tradeEvidence: over.tradeEvidence === undefined ? tradeWindowAt(decisionTs, over.tradeCoverage ?? {}) : over.tradeEvidence,
  };
};

test('the canonical V3 recipe binds the actual six derivations, units, lookbacks and upstream versions—not a version alias', () => {
  assert.equal(JUDGE_LEARNING_RECIPE_VERSION, 'judge-prepared-market-features-3');
  assert.equal(judgeLearningFeatureRecipeError(JUDGE_LEARNING_FEATURE_RECIPE), null);
  assert.equal(JUDGE_LEARNING_FEATURE_RECIPE.featureRecipeVersion, JUDGE_LEARNING_RECIPE_VERSION);
  assert.deepEqual(JUDGE_LEARNING_FEATURE_RECIPE.upstreamVersions, { marketFeatureVersion: FEATURE_VERSION, strategyVersion: STRATEGY_VERSION, bookSnapshotVersion: 'execution-book-snapshot-1' });
  assert.deepEqual(JUDGE_LEARNING_FEATURE_RECIPE.features.map((f) => [f.name, f.lookbackMs]), [
    ['atrPct', 3_660_000], ['bidDepthUsd10bps', 0], ['fi15', 15_000], ['fi60', 60_000], ['rv60', 1_260_000], ['spreadBps', 0],
  ]);
  assert.equal(JUDGE_LEARNING_FEATURE_RECIPE.features.find((f) => f.name === 'bidDepthUsd10bps').units, 'USD_QUOTE_NOTIONAL_BID_SIDE_WITHIN_10BPS_OF_MID');
  assert.equal(JUDGE_LEARNING_FEATURE_RECIPE.features.find((f) => f.name === 'rv60').units, 'RATIO_LAST_CLOSED_60S_QUOTE_NOTIONAL_TO_MEDIAN_PRIOR_20');
  assert.match(JUDGE_LEARNING_FEATURE_RECIPE.features.find((f) => f.name === 'fi15').supportLaw, /RETAINED_GAP_AT_OR_BEFORE_START/);
  assert.match(JUDGE_LEARNING_FEATURE_RECIPE.features.find((f) => f.name === 'rv60').supportLaw, /RETAINED_GAP_AT_OR_BEFORE_START/);
  assert.equal(judgeLearningFeatureRecipeDigestOf(JUDGE_LEARNING_FEATURE_RECIPE), JUDGE_LEARNING_FEATURE_RECIPE_DIGEST);

  const changed = clone(JUDGE_LEARNING_FEATURE_RECIPE);
  changed.features.find((f) => f.name === 'rv60').transform = 'SAME_ALIAS_DIFFERENT_FORMULA';
  assert.notEqual(judgeLearningFeatureRecipeDigestOf(changed), JUDGE_LEARNING_FEATURE_RECIPE_DIGEST, 'same version alias cannot preserve identity after a body change');
  assert.match(judgeLearningFeatureRecipeError(changed), /content differs/);
  const duplicate = clone(JUDGE_LEARNING_FEATURE_RECIPE); duplicate.features[1].name = 'atrPct';
  assert.match(judgeLearningFeatureRecipeError(duplicate), /duplicate/);
  const unknown = clone(JUDGE_LEARNING_FEATURE_RECIPE); unknown.features[1].name = 'futureProfit';
  assert.match(judgeLearningFeatureRecipeError(unknown), /unknown/);

  const priorCapture = clone(buildJudgeLearningPreparedFacts(inputs()));
  priorCapture.featureRecipeVersion = 'judge-prepared-market-features-2';
  priorCapture.factsDigest = judgeLearningPreparedFactsDigestOf(priorCapture);
  assert.match(judgeLearningPreparedFactsError(priorCapture), /recipe identity mismatch/, 'a pre-change capture cannot be relabelled under the historical-gap semantics');
});

test('a real retained feed gap is historical after a full clean window; an inside-window gap or short reset never earns RV credit', () => {
  const gapAt = D - 21 * 60_000;
  let now = gapAt - FEED_DEFAULTS.impairedAfterMs - 1;
  const feed = createExecutionFeed({ clock: () => now });
  feed.admit('XBT/USD', { priority: 'CANDIDATE' });
  feed.onConnect(now);
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), now);
  now = gapAt;
  feed.ingest(JSON.stringify({ channel: 'heartbeat' }), now);
  for (now = gapAt + 4_000; now <= D; now += 4_000) feed.ingest(JSON.stringify({ channel: 'heartbeat' }), now);
  now = D;
  const recoveredCoverage = feed.coverage('XBT/USD', D);
  assert.deepEqual(recoveredCoverage, { continuous: true, epoch: 1, startTs: gapAt, endTs: D, gapTs: gapAt });

  const recovered = tradeWindowAt(D);
  recovered.coverage = recoveredCoverage;
  for (const row of recovered.trades) row.feedEpoch = recoveredCoverage.epoch;
  const recoveredFacts = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: recovered }));
  assert.equal(recoveredFacts.features.fi15.availability, 'KNOWN');
  assert.equal(recoveredFacts.features.rv60.availability, 'KNOWN', 'the retained diagnostic gap does not poison the clean interval that begins at that gap');

  for (const gapTs of [gapAt + 1, D + 1, -1, 1.5]) {
    const invalid = clone(recovered);
    invalid.coverage.gapTs = gapTs;
    const facts = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: invalid }));
    for (const name of ['fi15', 'fi60', 'rv60']) assert.equal(facts.features[name].availability, 'UNAVAILABLE');
  }

  const shortStart = D - 20 * 60_000;
  const short = clone(recovered);
  short.coverage.startTs = shortStart;
  short.coverage.gapTs = shortStart;
  short.trades = short.trades.filter((row) => row.receiptTs >= shortStart);
  const shortFacts = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: short }));
  assert.equal(shortFacts.features.fi15.availability, 'KNOWN', 'the recent FI window is independently covered');
  assert.equal(shortFacts.features.rv60.availability, 'UNAVAILABLE', 'twenty clean minutes cannot satisfy the strict twenty-one-minute RV law');
});

test('pure prepared facts reproduce six current sources with truthful clocks/support and renamed bid-only depth', () => {
  const facts = buildJudgeLearningPreparedFacts(inputs());
  assert.equal(judgeLearningPreparedFactsError(facts), null);
  assert.deepEqual(facts.marketIdentity, { symbol: 'XBT/USD', canonicalCoin: 'BTC' });
  assert.equal(facts.featureRecipeDigest, JUDGE_LEARNING_FEATURE_RECIPE_DIGEST);
  assert.equal(facts.features.rv60.value, 2.5);
  assert.equal(facts.features.rv60.lookbackMs, 21 * 60_000);
  assert.equal(facts.features.rv60.ageMs, 0, 'age zero is derived from the exact closed-window E, not assumed');
  assert.equal(facts.features.fi15.ageMs, 0, 'FI age is decisionTs-endTs after exact window-clock validation');
  assert.equal(facts.features.fi15.value, 0.25);
  assert.equal(facts.features.fi60.value, 0.1);
  assert.equal(facts.features.fi15.support.classifiedFraction, 1);
  assert.equal(facts.features.fi15.support.sourceDigest, facts.sourceEvidence.tradeEvidence.evidenceDigest);
  assert.equal(facts.features.fi15.support.feedEpoch, 7);
  assert.equal(facts.sourceEvidence.tradeEvidence.knownAtCeilingTs, D - 4_999);
  assert.ok(Math.abs(facts.features.spreadBps.value - 10) < 1e-9, 'spread preserves the current numeric Judge transform');
  assert.equal(facts.features.spreadBps.ageMs, 250, 'book receipt age is preserved, never reset to zero');
  assert.equal(facts.features.spreadBps.support.sourceDigest, facts.sourceEvidence.bookSnapshot.digest);
  assert.equal(facts.features.spreadBps.support.feedEpoch, 7);
  assert.equal(facts.features.spreadBps.support.receiptSequence, 99);
  assert.equal(facts.features.bidDepthUsd10bps.value, 24_987.5);
  assert.equal(facts.features.bidDepthUsd10bps.units, 'USD_QUOTE_NOTIONAL_BID_SIDE_WITHIN_10BPS_OF_MID');
  assert.equal(facts.features.atrPct.value, 1);
  assert.equal(facts.features.atrPct.ageMs, 60_000, 'ATR age comes from the frozen bar reference clock');
  assert.equal(facts.features.atrPct.support.startTs, D - 60_000 - 61 * 60_000);
  assert.equal(facts.features.atrPct.support.sourceDigest, facts.sourceEvidence.barEvidence.evidenceDigest);
});

test('missing/gapped/malformed raw trade evidence is UNAVAILABLE, never retained values or invented zeros', () => {
  const gap = buildJudgeLearningPreparedFacts(inputs({ tradeCoverage: { continuous: false } }));
  for (const name of ['rv60', 'fi15', 'fi60']) {
    assert.equal(gap.features[name].availability, 'UNAVAILABLE');
    assert.equal(gap.features[name].value, null);
    assert.match(gap.features[name].reason, /SOURCE_UNAVAILABLE/);
  }
  const malformedInput = tradeWindowAt(D); malformedInput.trades[0].quoteNotional = '999';
  const malformed = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: malformedInput }));
  assert.equal(malformed.sourceEvidence.tradeEvidence, null);
  assert.equal(malformed.features.fi15.availability, 'UNAVAILABLE');
  assert.match(judgeLearningPreparedFactsError(malformed, { consumerContract: contract() }), /required feature fi15 unavailable/);
  const overbound = tradeWindowAt(D); overbound.trades = Array(JUDGE_LEARNING_MAX_RAW_TRADES + 1).fill(overbound.trades[0]);
  const bounded = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: overbound }));
  assert.equal(bounded.sourceEvidence.tradeEvidence, null, 'the raw proof is bounded rather than truncated or partially credited');
});

test('stale book/bar facts remain honestly aged and a consumer freshness envelope refuses them', () => {
  const stale = buildJudgeLearningPreparedFacts(inputs({ bookAgeMs: 120_001, referenceTs: D - 120_001 }));
  assert.equal(stale.features.spreadBps.ageMs, 120_001);
  assert.equal(stale.features.bidDepthUsd10bps.ageMs, 120_001);
  assert.equal(stale.features.atrPct.ageMs, 120_001);
  assert.match(judgeLearningPreparedFactsError(stale, { consumerContract: contract() }), /stale/);
  const noClock = buildJudgeLearningPreparedFacts(inputs({ bookSnapshot: null, frozen: { referenceTs: D + 1 } }));
  assert.equal(noClock.features.spreadBps.availability, 'UNAVAILABLE');
  assert.equal(noClock.features.atrPct.availability, 'UNAVAILABLE');
});

test('prepared-fact identity rejects unit/lookback/value tampering even when the attacker recomputes the outer digest', () => {
  const original = buildJudgeLearningPreparedFacts(inputs());
  const wrongUnit = clone(original); wrongUnit.features.bidDepthUsd10bps.units = 'GENERIC_USD_DEPTH'; wrongUnit.factsDigest = judgeLearningPreparedFactsDigestOf(wrongUnit);
  assert.match(judgeLearningPreparedFactsError(wrongUnit), /identity, units or lookback mismatch/);
  const wrongLookback = clone(original); wrongLookback.features.rv60.lookbackMs = 60_000; wrongLookback.factsDigest = judgeLearningPreparedFactsDigestOf(wrongLookback);
  assert.match(judgeLearningPreparedFactsError(wrongLookback), /identity, units or lookback mismatch/);
  const inDomain = clone(original); inDomain.features.fi15.value = 0.3; inDomain.factsDigest = judgeLearningPreparedFactsDigestOf(inDomain);
  assert.match(judgeLearningPreparedFactsError(inDomain), /do not reproduce source evidence/);
});

test('support clocks are recomputed: future/end-point and arbitrary point-support rewrites cannot survive a new outer digest', () => {
  const original = buildJudgeLearningPreparedFacts(inputs());
  const futureFi = clone(original);
  futureFi.features.fi15.support.endTs = D + 60_000;
  futureFi.factsDigest = judgeLearningPreparedFactsDigestOf(futureFi);
  assert.match(judgeLearningPreparedFactsError(futureFi), /flow support unproven|do not reproduce/);

  const falseRvClock = clone(original);
  falseRvClock.features.rv60.sourceReferenceTs = D;
  falseRvClock.features.rv60.ageMs = 0;
  falseRvClock.features.rv60.support.startTs = 1;
  falseRvClock.features.rv60.support.endTs = 2;
  falseRvClock.factsDigest = judgeLearningPreparedFactsDigestOf(falseRvClock);
  assert.match(judgeLearningPreparedFactsError(falseRvClock), /relative-volume support unproven|do not reproduce/);

  const falsePoint = clone(original);
  falsePoint.features.spreadBps.support.startTs = 1;
  falsePoint.features.spreadBps.support.endTs = 2;
  falsePoint.factsDigest = judgeLearningPreparedFactsDigestOf(falsePoint);
  assert.match(judgeLearningPreparedFactsError(falsePoint), /book support malformed|do not reproduce/);
});

test('book and bar facts are internally reproducible from bounded raw evidence, not trusted scalar/digest assertions', () => {
  const original = buildJudgeLearningPreparedFacts(inputs());
  const changedBook = clone(original);
  changedBook.sourceEvidence.bookSnapshot.bids[0][0] = '99.94';
  changedBook.sourceEvidence.bookSnapshot.digest = digestOf({ ...changedBook.sourceEvidence.bookSnapshot, digest: null });
  changedBook.factsDigest = judgeLearningPreparedFactsDigestOf(changedBook);
  assert.match(judgeLearningPreparedFactsError(changedBook), /do not reproduce source evidence/, 'an in-domain raw book change must force new spread/depth/support facts');

  const changedBar = clone(original);
  changedBar.sourceEvidence.barEvidence.bars[10].high = 101;
  changedBar.sourceEvidence.barEvidence.evidenceDigest = digestOf({
    featureVersion: changedBar.sourceEvidence.barEvidence.featureVersion,
    symbol: changedBar.sourceEvidence.barEvidence.symbol,
    canonicalCoin: changedBar.sourceEvidence.barEvidence.canonicalCoin,
    bars: changedBar.sourceEvidence.barEvidence.bars,
    knownAtTs: changedBar.sourceEvidence.barEvidence.knownAtTs,
  });
  changedBar.factsDigest = judgeLearningPreparedFactsDigestOf(changedBar);
  assert.match(judgeLearningPreparedFactsError(changedBar), /does not reproduce frozen indicator/, 'a new bar digest cannot retrofit the frozen ATR identity');

  const changedTrade = clone(original);
  const row = changedTrade.sourceEvidence.tradeEvidence.trades.at(-1);
  row.qty = '0.5'; row.quoteNotional = '50';
  const tradeBody = { ...changedTrade.sourceEvidence.tradeEvidence }; delete tradeBody.evidenceDigest;
  changedTrade.sourceEvidence.tradeEvidence.evidenceDigest = digestOf(tradeBody);
  changedTrade.factsDigest = judgeLearningPreparedFactsDigestOf(changedTrade);
  assert.match(judgeLearningPreparedFactsError(changedTrade), /do not reproduce source evidence/, 'an in-domain raw trade change forces new FI/RV facts even after rehashing');

  const noBook = buildJudgeLearningPreparedFacts(inputs({ bookSnapshot: null }));
  assert.equal(noBook.features.spreadBps.availability, 'UNAVAILABLE');
  assert.equal(noBook.features.bidDepthUsd10bps.availability, 'UNAVAILABLE');
  assert.equal(noBook.features.atrPct.availability, 'UNAVAILABLE', 'ATR percentage also needs the decision-time midpoint');
  const noBars = buildJudgeLearningPreparedFacts(inputs({ barEvidence: null }));
  assert.equal(noBars.features.atrPct.availability, 'UNAVAILABLE', 'a frozen scalar and arbitrary digest alone never establish ATR');
  assert.equal(judgeLearningPreparedFactsError(noBars), null, 'honest unavailability remains a valid record');
});

test('future source evidence is normalized to non-credit and bar knownAt must precede the frozen trigger', () => {
  const futureBook = snapshotAt(D + 1);
  const bookFacts = buildJudgeLearningPreparedFacts(inputs({ bookSnapshot: futureBook }));
  assert.equal(bookFacts.sourceEvidence.bookSnapshot, null);
  assert.equal(bookFacts.features.spreadBps.availability, 'UNAVAILABLE');

  const normal = inputs();
  const lateBarEvidence = clone(normal.barEvidence);
  lateBarEvidence.knownAtTs[60] = normal.frozen.triggerTs + 1;
  const barFacts = buildJudgeLearningPreparedFacts({ ...normal, barEvidence: lateBarEvidence });
  assert.equal(barFacts.sourceEvidence.barEvidence, null);
  assert.equal(barFacts.features.atrPct.availability, 'UNAVAILABLE');

  const hindsight = clone(normal.barEvidence);
  hindsight.bars[0].outcomeLabel = 'ROSE_LATER';
  const hindsightFacts = buildJudgeLearningPreparedFacts({ ...normal, barEvidence: hindsight });
  assert.equal(hindsightFacts.sourceEvidence.barEvidence, null, 'the raw evidence schema is closed against cohort/outcome labels');
  assert.equal(hindsightFacts.features.atrPct.availability, 'UNAVAILABLE');

  const lateTrades = tradeWindowAt(D);
  lateTrades.trades.at(-1).receiptTs = D + 1;
  const lateFacts = buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: lateTrades }));
  assert.equal(lateFacts.sourceEvidence.tradeEvidence, null, 'an event timestamp before D cannot hide a receipt after D');
  for (const name of ['fi15', 'fi60', 'rv60']) assert.equal(lateFacts.features[name].availability, 'UNAVAILABLE');
});

test('one exact market identity binds book, raw trades and bars; missing bar identity withholds ATR and mixed sources are refused', () => {
  const normal = inputs();
  const unidentifiedBars = clone(normal.barEvidence); delete unidentifiedBars.canonicalCoin;
  const withheld = buildJudgeLearningPreparedFacts({ ...normal, barEvidence: unidentifiedBars });
  assert.equal(withheld.features.atrPct.availability, 'UNAVAILABLE', 'bar identity is never inferred from the matching book/trades');
  assert.deepEqual(withheld.marketIdentity, { symbol: 'XBT/USD', canonicalCoin: 'BTC' });

  const mixedTrades = tradeWindowAt(D);
  for (const trade of mixedTrades.trades) { trade.symbol = 'ETH/USD'; trade.canonicalCoin = 'ETH'; }
  assert.throws(() => buildJudgeLearningPreparedFacts(inputs({ tradeEvidence: mixedTrades })), /CROSS_SOURCE_MARKET_IDENTITY_MISMATCH/);

  const rehashed = clone(buildJudgeLearningPreparedFacts(normal));
  rehashed.sourceEvidence.barEvidence.symbol = 'ETH/USD';
  rehashed.sourceEvidence.barEvidence.canonicalCoin = 'ETH';
  rehashed.sourceEvidence.barEvidence.evidenceDigest = digestOf({
    featureVersion: rehashed.sourceEvidence.barEvidence.featureVersion,
    symbol: rehashed.sourceEvidence.barEvidence.symbol,
    canonicalCoin: rehashed.sourceEvidence.barEvidence.canonicalCoin,
    bars: rehashed.sourceEvidence.barEvidence.bars,
    knownAtTs: rehashed.sourceEvidence.barEvidence.knownAtTs,
  });
  rehashed.factsDigest = judgeLearningPreparedFactsDigestOf(rehashed);
  assert.match(judgeLearningPreparedFactsError(rehashed), /CROSS_SOURCE_MARKET_IDENTITY_MISMATCH/, 'rehashing cannot turn a cross-asset frame into a valid prepared record');
});

test('consumer contract seals RR-point transform/magnitude, exact producers and batch validation before any capture', () => {
  const c = contract();
  assert.equal(judgeLearningConsumerContractError(c), null);
  assert.equal(c.effect.units, JUDGE_LEARNING_EFFECT_UNITS);
  assert.equal(c.effect.target, 'REWARD_RISK_RATIO');
  assert.equal(c.effect.targetProducerVersion, COST_MODEL_VERSION);
  assert.equal(c.effect.rankingLawVersion, RISK_VERSION);
  assert.equal(c.effect.magnitude, 0.05);
  assert.equal(c.validationSemantics.experimentalUnit, 'ADMISSION_BATCH');
  assert.equal(c.validationSemantics.noOrderAuthority, true);
  assert.equal(c.maxSizeUsd, null);
  assert.equal(judgeLearningPreparedFactsError(buildJudgeLearningPreparedFacts(inputs()), { consumerContract: c }), null);

  const tampered = clone(c); tampered.effect.magnitude = 0.1;
  assert.match(judgeLearningConsumerContractError(tampered), /digest mismatch/);
  const newlySealed = contract({ effectMagnitude: 0.1 });
  assert.equal(judgeLearningConsumerContractError(newlySealed), null);
  assert.notEqual(newlySealed.consumerContractDigest, c.consumerContractDigest, 'a different predeclared magnitude is a different contract, never a settlement-time tweak');
  assert.throws(() => contract({ effectMagnitude: 0.05001 }), /magnitude malformed/);
  const wrongUnits = clone(c); wrongUnits.effect.units = 'BASELINE_SCORE_UNITS';
  assert.match(judgeLearningConsumerContractError(wrongUnits), /transform or units mismatch/);
});

test('consumer eligibility is canonical, rejects unknown features and binds policy/body content', () => {
  const a = contract();
  assert.deepEqual(a.eligibility.requiredFeatures, ['atrPct', 'bidDepthUsd10bps', 'fi15', 'fi60', 'rv60', 'spreadBps']);
  assert.throws(() => contract({ eligibility: { requiredFeatures: ['rv60', 'futureProfit'] } }), /unknown feature/);
  const alteredRecipe = clone(a);
  alteredRecipe.featureRecipe.features.find((f) => f.name === 'spreadBps').units = 'PERCENT';
  alteredRecipe.featureRecipeDigest = judgeLearningFeatureRecipeDigestOf(alteredRecipe.featureRecipe);
  assert.match(judgeLearningConsumerContractError(alteredRecipe), /content differs from canonical derivations/);
  const alteredPolicy = clone(a); alteredPolicy.policyDigest = 'b'.repeat(64);
  assert.match(judgeLearningConsumerContractError(alteredPolicy), /digest mismatch/);
});
