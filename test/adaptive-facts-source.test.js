import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_JUDGE_FACTS_ENVELOPE_VERSION,
  MAX_ADAPTIVE_FACTS_SOURCE_BYTES, adaptiveJudgeFactsEnvelopeError,
  adaptiveJudgeFactsSourceError, prepareAdaptiveJudgeFacts,
} from '../judge/adaptive-facts-source.js';
import { JUDGE_LEARNING_MAX_RAW_TRADES } from '../judge/learning-recipe.js';
import { digestOf, instrumentSpec } from '../execution/contract.js';
import { FEATURE_VERSION, indicatorBlock } from '../judge/features.js';
import { STRATEGY_VERSION } from '../judge/setups.js';

const D = 1_789_300_800_000;
const MIN = 60_000;
const clone = (value) => structuredClone(value);

function spec() {
  return instrumentSpec({
    venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'BTC/USD',
    base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online',
    priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005',
    costMin: '0.5', priceDecimals: 1, qtyDecimals: 8,
    observedTs: D - 2 * MIN, source: 'REST_ASSET_PAIRS',
  });
}

function book(instrument, over = {}) {
  const snapshot = {
    snapshotVersion: 'execution-book-snapshot-1', symbol: 'BTC/USD', canonicalCoin: 'BTC',
    feedEpoch: 7, receiptSequence: 900, nativeSequence: null, sourceTs: D - 300,
    receiptTs: D - 250, crc: 1, crcVerified: true, crcComputed: 1, synced: true,
    instrumentDigest: instrument.specDigest, priceDecimals: 1, qtyDecimals: 8,
    bids: [['99.9', '250'], ['99.8', '100']], asks: [['100.1', '250'], ['100.2', '100']],
    levelsCap: 100, truncated: false, kind: 'UPDATE', digest: '0'.repeat(64),
    ...over,
  };
  snapshot.digest = digestOf({ ...snapshot, digest: null });
  return snapshot;
}

function barsAndFrozen() {
  const referenceTs = D - MIN;
  const historicalBars = Array.from({ length: 61 }, (_, index) => {
    const periodStartTs = referenceTs - (61 - index) * MIN;
    return {
      periodStartTs, periodEndTs: periodStartTs + MIN,
      open: 100, high: 100.5, low: 99.5, close: 100,
      volumeQuote: 1_000, volumeBase: 10, closed: true,
      knownAtTs: periodStartTs + MIN + 10,
      tradeCount: 12, source: 'REST_OHLC',
    };
  });
  const projected = historicalBars.map(({ knownAtTs: _knownAtTs, tradeCount: _tradeCount, source: _source, ...row }) => row);
  const block = indicatorBlock(projected, { referenceTs: D });
  return {
    historicalBars,
    frozenIndicator: {
      strategyVersion: STRATEGY_VERSION, triggerTs: D - 500,
      blockDigest: block.blockDigest, referenceTs: block.referenceTs,
      atr14: String(block.atr14),
    },
  };
}

function rawTrade({ eventTs, receiptSequence, side, quoteNotional }) {
  return {
    tradeVersion: 'execution-trade-1', symbol: 'BTC/USD', canonicalCoin: 'BTC',
    feedEpoch: 7, receiptSequence, nativeTradeId: `trade-${receiptSequence}`,
    side, price: '100', qty: String(quoteNotional / 100), quoteNotional: String(quoteNotional),
    eventTs, receiptTs: eventTs + 1, fromSubscriptionSnapshot: false, orderType: 'market',
  };
}

function flow() {
  const trades = []; let sequence = 1;
  for (let minutesAgo = 21; minutesAgo >= 2; minutesAgo -= 1) {
    const start = D - minutesAgo * MIN;
    trades.push(rawTrade({ eventTs: start + 20_000, receiptSequence: sequence++, side: 'buy', quoteNotional: 50 }));
    trades.push(rawTrade({ eventTs: start + 40_000, receiptSequence: sequence++, side: 'sell', quoteNotional: 50 }));
  }
  trades.push(rawTrade({ eventTs: D - 50_000, receiptSequence: sequence++, side: 'buy', quoteNotional: 75 }));
  trades.push(rawTrade({ eventTs: D - 30_000, receiptSequence: sequence++, side: 'sell', quoteNotional: 75 }));
  trades.push(rawTrade({ eventTs: D - 10_000, receiptSequence: sequence++, side: 'buy', quoteNotional: 62.5 }));
  trades.push(rawTrade({ eventTs: D - 5_000, receiptSequence: sequence++, side: 'sell', quoteNotional: 37.5 }));
  return {
    coverage: { continuous: true, epoch: 7, startTs: D - 22 * MIN, endTs: D, gapTs: null },
    trades,
  };
}

function validInput() {
  const instrument = spec();
  return {
    decisionTs: D,
    requestedMarket: { venue: 'kraken', symbol: 'BTC/USD', canonicalCoin: 'BTC', quote: 'USD' },
    instrumentSpec: instrument, bookSnapshot: book(instrument),
    ...barsAndFrozen(), flowWindow: flow(),
  };
}

test('source preflight refuses accessor and hidden/non-JSON values without invoking caller code', () => {
  let calls = 0;
  const input = validInput();
  const original = input.decisionTs;
  Object.defineProperty(input, 'decisionTs', { enumerable: true, get() { calls += 1; return original; } });
  assert.notEqual(adaptiveJudgeFactsSourceError(input), null);
  assert.equal(calls, 0);
  for (const mutate of [
    (v) => { v[Symbol('hidden')] = 'discarded'; },
    (v) => { Object.defineProperty(v, 'hidden', { value: 'discarded', enumerable: false }); },
    (v) => { v.flowWindow.trades.extra = true; },
    (v) => { v.historicalBars[0].tradeCount = NaN; },
  ]) {
    const value = validInput(); mutate(value);
    assert.notEqual(adaptiveJudgeFactsSourceError(value), null);
  }
});

test('source sidecar cannot re-label bar/flow market identity when the book is absent', () => {
  const input = validInput(); input.bookSnapshot = null;
  const envelope = clone(prepareAdaptiveJudgeFacts(input));
  assert.equal(adaptiveJudgeFactsEnvelopeError(envelope), null);
  const rawSpec = { ...envelope.sourceBinding.instrument, pairKey: 'XETHZUSD', altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', canonicalCoin: 'ETH' };
  delete rawSpec.specDigest;
  envelope.sourceBinding.instrument = instrumentSpec(rawSpec);
  envelope.sourceBinding.market = { venue: 'kraken', symbol: 'ETH/USD', canonicalCoin: 'ETH', quote: 'USD' };
  const body = { ...envelope.sourceBinding }; delete body.sourceId; delete body.sourceDigest;
  envelope.sourceBinding.sourceDigest = digestOf(body);
  envelope.sourceBinding.sourceId = `jafsrc-${envelope.sourceBinding.sourceDigest.slice(0, 40)}`;
  assert.notEqual(adaptiveJudgeFactsEnvelopeError(envelope), null);
});

test('JSON escaping cannot amplify a source past the byte ceiling before preflight refusal', () => {
  const input = validInput();
  input.historicalBars[0].source = '\u0000'.repeat(Math.floor(MAX_ADAPTIVE_FACTS_SOURCE_BYTES / 6) + 1);
  assert.equal(adaptiveJudgeFactsSourceError(input), 'SOURCE_BYTE_LIMIT_EXCEEDED');
  const cyclic = validInput(); cyclic.historicalBars[0].coverage = cyclic;
  assert.equal(adaptiveJudgeFactsSourceError(cyclic), 'SOURCE_CYCLE_REFUSED');
});

test('real-shaped accepted inputs produce immutable V3 facts and an explicit non-authenticating source sidecar', () => {
  const input = validInput();
  const envelope = prepareAdaptiveJudgeFacts(input);
  assert.equal(envelope.envelopeVersion, ADAPTIVE_JUDGE_FACTS_ENVELOPE_VERSION);
  assert.equal(adaptiveJudgeFactsEnvelopeError(envelope), null);
  assert.deepEqual(envelope.facts.marketIdentity, { symbol: 'BTC/USD', canonicalCoin: 'BTC' });
  assert.deepEqual(Object.values(envelope.facts.features).map((fact) => fact.availability), Array(6).fill('KNOWN'));
  assert.equal(envelope.sourceBinding.market.venue, 'kraken');
  assert.equal(envelope.sourceBinding.instrument.pairKey, 'XXBTZUSD');
  assert.equal(envelope.sourceBinding.instrument.base, 'XXBT');
  assert.equal(envelope.sourceBinding.instrument.quote, 'ZUSD');
  assert.equal(envelope.sourceBinding.book.instrumentDigest, input.instrumentSpec.specDigest);
  assert.equal(envelope.sourceBinding.bars.count, 61);
  assert.equal(envelope.sourceBinding.bars.knownAtCeilingTs, input.historicalBars.at(-1).knownAtTs);
  assert.equal(envelope.sourceBinding.flow.count, input.flowWindow.trades.length);
  assert.match(envelope.sourceBinding.limitations.join('|'), /NOT_PROVIDER_AUTHENTICATION/);
  assert.match(envelope.sourceBinding.limitations.join('|'), /FIRST_WRITE_PROSPECTIVE_CUSTODY_NOT_ESTABLISHED/);

  const originalFactsDigest = envelope.facts.factsDigest;
  const originalSourceDigest = envelope.sourceBinding.sourceDigest;
  input.bookSnapshot.bids[0][0] = '1';
  input.historicalBars[0].knownAtTs += 1;
  input.flowWindow.trades[0].side = 'sell';
  assert.equal(envelope.facts.factsDigest, originalFactsDigest, 'caller mutation cannot alter prepared facts');
  assert.equal(envelope.sourceBinding.sourceDigest, originalSourceDigest, 'caller mutation cannot alter the source sidecar');
  assert.equal(adaptiveJudgeFactsEnvelopeError(envelope), null);
});

test('requested venue, pair, quote, canonical coin and exact instrument digest are closed', () => {
  for (const mutate of [
    (input) => { input.requestedMarket.venue = 'coinbase'; },
    (input) => { input.requestedMarket.symbol = 'ETH/USD'; },
    (input) => { input.requestedMarket.quote = 'EUR'; },
    (input) => { input.requestedMarket.canonicalCoin = 'ETH'; },
    (input) => { input.bookSnapshot.instrumentDigest = 'f'.repeat(64); input.bookSnapshot.digest = digestOf({ ...input.bookSnapshot, digest: null }); },
    (input) => { input.bookSnapshot.priceDecimals = 2; input.bookSnapshot.digest = digestOf({ ...input.bookSnapshot, digest: null }); },
  ]) {
    const input = validInput(); mutate(input);
    assert.throws(() => prepareAdaptiveJudgeFacts(input), /MISMATCH/);
  }
  const futureSpec = validInput();
  futureSpec.instrumentSpec = instrumentSpec({ ...futureSpec.instrumentSpec, observedTs: D + 1, specDigest: undefined });
  assert.match(adaptiveJudgeFactsSourceError(futureSpec), /NOT_ACCEPTED_AS_OF_DECISION/);
});

test('late bars/trades, subscription snapshots and stale cross-source epochs fail before V3 replay', () => {
  const lateBar = validInput(); lateBar.historicalBars.at(-1).knownAtTs = D + 1;
  assert.match(adaptiveJudgeFactsSourceError(lateBar), /KNOWN_AT_INVALID/);

  const lateTrade = validInput(); lateTrade.flowWindow.trades.at(-1).receiptTs = D + 1;
  assert.match(adaptiveJudgeFactsSourceError(lateTrade), /CHRONOLOGY_INVALID/);

  const subscription = validInput(); subscription.flowWindow.trades[0].fromSubscriptionSnapshot = true;
  assert.match(adaptiveJudgeFactsSourceError(subscription), /SNAPSHOT_INVALID/);

  const staleEpoch = validInput(); staleEpoch.bookSnapshot.feedEpoch = 6;
  staleEpoch.bookSnapshot.digest = digestOf({ ...staleEpoch.bookSnapshot, digest: null });
  assert.equal(adaptiveJudgeFactsSourceError(staleEpoch), 'BOOK_FLOW_EPOCH_MISMATCH');

  const wrongNotional = validInput(); wrongNotional.flowWindow.trades[0].quoteNotional = '51';
  assert.match(adaptiveJudgeFactsSourceError(wrongNotional), /QUOTE_NOTIONAL_INVALID/);

  const duplicate = validInput(); duplicate.flowWindow.trades[1].nativeTradeId = duplicate.flowWindow.trades[0].nativeTradeId;
  assert.match(adaptiveJudgeFactsSourceError(duplicate), /DUPLICATE_IDENTITY/);
});

test('missing keys and partial evidence refuse; explicit null sources remain unavailable rather than fabricated zeros', () => {
  const missing = validInput(); delete missing.flowWindow;
  assert.equal(adaptiveJudgeFactsSourceError(missing), 'SOURCE_INPUT_SCHEMA_NOT_CLOSED');
  const unknown = validInput(); unknown.historicalBars[0].futureProfit = 5;
  assert.match(adaptiveJudgeFactsSourceError(unknown), /SCHEMA_NOT_CLOSED/);
  const partial = validInput(); partial.frozenIndicator = null;
  assert.equal(adaptiveJudgeFactsSourceError(partial), 'FROZEN_INDICATOR_AND_BARS_MUST_BE_PRESENT_TOGETHER');

  const absent = validInput();
  absent.frozenIndicator = null; absent.historicalBars = null; absent.flowWindow = null;
  const envelope = prepareAdaptiveJudgeFacts(absent);
  assert.equal(envelope.facts.features.spreadBps.availability, 'KNOWN');
  assert.equal(envelope.facts.features.bidDepthUsd10bps.availability, 'KNOWN');
  for (const name of ['atrPct', 'fi15', 'fi60', 'rv60']) {
    assert.equal(envelope.facts.features[name].availability, 'UNAVAILABLE');
    assert.equal(envelope.facts.features[name].value, null);
  }
  assert.equal(envelope.sourceBinding.bars.state, 'UNAVAILABLE');
  assert.equal(envelope.sourceBinding.flow.state, 'UNAVAILABLE');

  const noBook = validInput(); noBook.bookSnapshot = null;
  const noBookEnvelope = prepareAdaptiveJudgeFacts(noBook);
  assert.equal(noBookEnvelope.facts.features.spreadBps.availability, 'UNAVAILABLE');
  assert.equal(noBookEnvelope.facts.features.bidDepthUsd10bps.availability, 'UNAVAILABLE');
  assert.equal(noBookEnvelope.facts.features.atrPct.availability, 'UNAVAILABLE', 'ATR percentage needs a same-market book midpoint');
  for (const name of ['fi15', 'fi60', 'rv60']) assert.equal(noBookEnvelope.facts.features[name].availability, 'KNOWN');
  assert.equal(noBookEnvelope.sourceBinding.book.state, 'UNAVAILABLE');
  assert.equal(adaptiveJudgeFactsEnvelopeError(noBookEnvelope), null);
});

test('trade, node and byte ceilings reject before cloning or derivation', () => {
  const tooManyTrades = validInput();
  tooManyTrades.flowWindow.trades = Array(JUDGE_LEARNING_MAX_RAW_TRADES + 1).fill(tooManyTrades.flowWindow.trades[0]);
  assert.equal(adaptiveJudgeFactsSourceError(tooManyTrades), 'FLOW_TRADE_LIMIT_EXCEEDED');

  const tooLarge = validInput();
  tooLarge.instrumentSpec = { ...tooLarge.instrumentSpec, altname: 'A'.repeat(MAX_ADAPTIVE_FACTS_SOURCE_BYTES + 1) };
  assert.equal(adaptiveJudgeFactsSourceError(tooLarge), 'SOURCE_BYTE_LIMIT_EXCEEDED');
});

test('tampered sidecar or facts cannot pass normal envelope readback', () => {
  const envelope = clone(prepareAdaptiveJudgeFacts(validInput()));
  envelope.sourceBinding.instrument.pairKey = 'OTHER';
  assert.equal(adaptiveJudgeFactsEnvelopeError(envelope), 'SOURCE_BINDING_INVALID');

  const rehashedSidecar = clone(prepareAdaptiveJudgeFacts(validInput()));
  rehashedSidecar.sourceBinding.flow.count += 1;
  const body = clone(rehashedSidecar.sourceBinding); delete body.sourceId; delete body.sourceDigest;
  rehashedSidecar.sourceBinding.sourceDigest = digestOf(body);
  rehashedSidecar.sourceBinding.sourceId = `jafsrc-${rehashedSidecar.sourceBinding.sourceDigest.slice(0, 40)}`;
  assert.equal(adaptiveJudgeFactsEnvelopeError(rehashedSidecar), 'SOURCE_BINDING_FACT_EVIDENCE_MISMATCH');

  const factsTamper = clone(prepareAdaptiveJudgeFacts(validInput()));
  factsTamper.facts.features.fi15.value = 0.99;
  assert.equal(adaptiveJudgeFactsEnvelopeError(factsTamper), 'ENVELOPE_OR_PREPARED_FACTS_INVALID');
});
