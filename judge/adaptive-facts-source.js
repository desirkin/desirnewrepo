// Pure normal-Judge source adapter for the sealed V3 learning recipe.
//
// This accepts the exact already-authorized market inputs that a normal Judge
// candidate owns. It does not fetch, authenticate, persist, qualify, or grant
// authority. Content digests identify the supplied bytes; they do not prove a
// provider supplied them or that an external first-write store captured them.
import {
  bookSnapshotError, digestOf, instrumentSpecError, shapeError, TRADE_SCHEMA,
} from '../execution/contract.js';
import * as M from '../execution/money.js';
import {
  JUDGE_LEARNING_MAX_RAW_TRADES, buildJudgeLearningPreparedFacts,
  judgeLearningPreparedFactsError,
} from './learning-recipe.js';
import { FEATURE_VERSION, indicatorBlock, validateBarBlock } from './features.js';
import { STRATEGY_VERSION } from './setups.js';

export const ADAPTIVE_JUDGE_FACTS_SOURCE_VERSION = 'judge-adaptive-facts-source-1';
export const ADAPTIVE_JUDGE_FACTS_ENVELOPE_VERSION = 'judge-adaptive-facts-envelope-1';
export const MAX_ADAPTIVE_FACTS_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_ADAPTIVE_FACTS_SOURCE_NODES = 250_000;
export const MAX_ADAPTIVE_FACTS_SOURCE_DEPTH = 16;

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const COIN = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const TOP_KEYS = Object.freeze([
  'decisionTs', 'requestedMarket', 'instrumentSpec', 'bookSnapshot',
  'frozenIndicator', 'historicalBars', 'flowWindow',
]);
const REQUEST_KEYS = Object.freeze(['venue', 'symbol', 'canonicalCoin', 'quote']);
const FROZEN_KEYS = Object.freeze(['strategyVersion', 'triggerTs', 'blockDigest', 'referenceTs', 'atr14']);
const COVERAGE_KEYS = Object.freeze(['continuous', 'epoch', 'startTs', 'endTs', 'gapTs']);
const REQUIRED_BAR_KEYS = Object.freeze([
  'periodStartTs', 'periodEndTs', 'open', 'high', 'low', 'close',
  'volumeQuote', 'volumeBase', 'closed', 'knownAtTs',
]);
const OPTIONAL_BAR_KEYS = Object.freeze(['tradeCount', 'source', 'coverage', 'epoch']);
const ALLOWED_BAR_KEYS = new Set([...REQUIRED_BAR_KEYS, ...OPTIONAL_BAR_KEYS]);
const ENVELOPE_KEYS = Object.freeze(['envelopeVersion', 'facts', 'sourceBinding']);
const BINDING_KEYS = Object.freeze([
  'sourceVersion', 'sourceId', 'sourceDigest', 'decisionTs', 'market',
  'instrument', 'book', 'bars', 'flow', 'preparedFactsDigest',
  'limitations', 'authority',
]);
const MARKET_KEYS = Object.freeze(['venue', 'symbol', 'canonicalCoin', 'quote']);
const BOOK_KEYS = Object.freeze([
  'state', 'snapshotDigest', 'instrumentDigest', 'receiptTs', 'sourceTs',
  'feedEpoch', 'receiptSequence',
]);
const BARS_KEYS = Object.freeze([
  'state', 'rawBarsDigest', 'preparedEvidenceDigest', 'count',
  'firstPeriodStartTs', 'lastPeriodEndTs', 'knownAtCeilingTs',
  'featureVersion', 'indicatorBlockDigest',
]);
const FLOW_KEYS = Object.freeze([
  'state', 'rawWindowDigest', 'preparedEvidenceDigest', 'count', 'byteCount',
  'coverageStartTs', 'coverageEndTs', 'retainedGapTs', 'feedEpoch',
  'firstReceiptSequence', 'lastReceiptSequence', 'knownAtCeilingTs',
]);
const LIMITATIONS = Object.freeze([
  'CONTENT_DIGESTS_ARE_NOT_PROVIDER_AUTHENTICATION',
  'FIRST_WRITE_PROSPECTIVE_CUSTODY_NOT_ESTABLISHED',
  'CALLSITE_MUST_CAPTURE_FULL_ENVELOPE_BEFORE_OUTCOME',
  'VENUE_IS_BOUND_BY_VALIDATED_SPEC_AND_SIDECAR_NOT_THE_V3_FACTS_BODY',
]);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isTs = (value) => Number.isSafeInteger(value) && value > 0;
const clone = (value) => structuredClone(value);
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};
const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sameNumber = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b))
  && Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b)));

function boundedStructureError(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0; let lowerBoundBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_ADAPTIVE_FACTS_SOURCE_NODES) return 'SOURCE_NODE_LIMIT_EXCEEDED';
    if (current.depth > MAX_ADAPTIVE_FACTS_SOURCE_DEPTH) return 'SOURCE_DEPTH_LIMIT_EXCEEDED';
    const item = current.value;
    if (typeof item === 'string') {
      lowerBoundBytes += Buffer.byteLength(item, 'utf8');
      if (lowerBoundBytes > MAX_ADAPTIVE_FACTS_SOURCE_BYTES) return 'SOURCE_BYTE_LIMIT_EXCEEDED';
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    if (seen.has(item)) return 'SOURCE_CYCLE_REFUSED';
    seen.add(item);
    const keys = Object.keys(item);
    for (const key of keys) {
      lowerBoundBytes += Buffer.byteLength(key, 'utf8');
      if (lowerBoundBytes > MAX_ADAPTIVE_FACTS_SOURCE_BYTES) return 'SOURCE_BYTE_LIMIT_EXCEEDED';
      stack.push({ value: item[key], depth: current.depth + 1 });
    }
  }
  let exactBytes;
  try { exactBytes = serializedBytes(value); } catch { return 'SOURCE_NOT_JSON_SERIALIZABLE'; }
  return exactBytes <= MAX_ADAPTIVE_FACTS_SOURCE_BYTES ? null : 'SOURCE_BYTE_LIMIT_EXCEEDED';
}

function marketError(requestedMarket, spec, decisionTs) {
  if (!exactKeys(requestedMarket, REQUEST_KEYS)
      || !ID.test(requestedMarket.venue ?? '') || !ID.test(requestedMarket.symbol ?? '')
      || !COIN.test(requestedMarket.canonicalCoin ?? '') || !ID.test(requestedMarket.quote ?? '')) {
    return 'REQUESTED_MARKET_INVALID';
  }
  const specError = instrumentSpecError(spec);
  if (specError) return `INSTRUMENT_SPEC_INVALID:${specError}`;
  const wsParts = spec.wsname.split('/');
  if (wsParts.length !== 2 || requestedMarket.venue !== spec.venue
      || requestedMarket.symbol !== spec.wsname
      || requestedMarket.canonicalCoin !== spec.canonicalCoin
      || requestedMarket.quote !== wsParts[1]) return 'REQUESTED_MARKET_SPEC_MISMATCH';
  if (spec.status !== 'online' || spec.observedTs > decisionTs) return 'INSTRUMENT_SPEC_NOT_ACCEPTED_AS_OF_DECISION';
  return null;
}

function bookError(snapshot, request, spec, decisionTs) {
  if (snapshot === null) return null;
  const error = bookSnapshotError(snapshot);
  if (error) return `BOOK_SNAPSHOT_INVALID:${error}`;
  if (snapshot.symbol !== request.symbol || snapshot.canonicalCoin !== request.canonicalCoin
      || snapshot.instrumentDigest !== spec.specDigest
      || snapshot.priceDecimals !== spec.priceDecimals
      || snapshot.qtyDecimals !== spec.qtyDecimals) return 'BOOK_SNAPSHOT_MARKET_OR_SPEC_MISMATCH';
  if (snapshot.synced !== true || snapshot.crcVerified !== true
      || snapshot.receiptTs > decisionTs
      || (snapshot.sourceTs !== null && snapshot.sourceTs > decisionTs)) return 'BOOK_SNAPSHOT_NOT_ACCEPTED_AS_OF_DECISION';
  return null;
}

function projectedBars(rawBars) {
  return rawBars.map((bar) => ({
    periodStartTs: bar.periodStartTs, periodEndTs: bar.periodEndTs,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volumeQuote: bar.volumeQuote, volumeBase: bar.volumeBase, closed: bar.closed,
  }));
}

function barsError(frozen, rawBars, decisionTs) {
  if (frozen === null && rawBars === null) return null;
  if (frozen === null || rawBars === null) return 'FROZEN_INDICATOR_AND_BARS_MUST_BE_PRESENT_TOGETHER';
  if (!exactKeys(frozen, FROZEN_KEYS) || frozen.strategyVersion !== STRATEGY_VERSION
      || !isTs(frozen.triggerTs) || frozen.triggerTs > decisionTs
      || !isTs(frozen.referenceTs) || frozen.referenceTs > frozen.triggerTs
      || !HEX64.test(frozen.blockDigest ?? '') || !Number.isFinite(Number(frozen.atr14))
      || Number(frozen.atr14) <= 0) return 'FROZEN_INDICATOR_INVALID';
  if (!Array.isArray(rawBars) || rawBars.length !== 61) return 'HISTORICAL_BARS_EXACT_61_REQUIRED';
  for (let index = 0; index < rawBars.length; index += 1) {
    const bar = rawBars[index];
    if (!isPlainObject(bar) || REQUIRED_BAR_KEYS.some((key) => !Object.hasOwn(bar, key))
        || Object.keys(bar).some((key) => !ALLOWED_BAR_KEYS.has(key))) return `HISTORICAL_BAR_${index}_SCHEMA_NOT_CLOSED`;
    if (!isTs(bar.knownAtTs) || bar.knownAtTs < bar.periodEndTs
        || bar.knownAtTs > frozen.triggerTs
        || (index > 0 && bar.knownAtTs < rawBars[index - 1].knownAtTs)) {
      return `HISTORICAL_BAR_${index}_KNOWN_AT_INVALID`;
    }
  }
  const projected = projectedBars(rawBars);
  const block = validateBarBlock(projected, { referenceTs: decisionTs });
  if (!block.ok) return `HISTORICAL_BARS_INVALID:${block.reason}`;
  let derived;
  try { derived = indicatorBlock(projected, { referenceTs: decisionTs }); }
  catch (error) { return `HISTORICAL_BARS_DERIVATION_FAILED:${error.message}`; }
  if (derived.featureVersion !== FEATURE_VERSION || derived.referenceTs !== frozen.referenceTs
      || derived.blockDigest !== frozen.blockDigest || !sameNumber(derived.atr14, frozen.atr14)) {
    return 'FROZEN_INDICATOR_DOES_NOT_REPRODUCE_BARS';
  }
  return null;
}

function flowError(flowWindow, request, bookSnapshot, decisionTs) {
  if (flowWindow === null) return null;
  if (!exactKeys(flowWindow, ['coverage', 'trades'])) return 'FLOW_WINDOW_SCHEMA_NOT_CLOSED';
  if (!Array.isArray(flowWindow.trades)) return 'FLOW_TRADES_NOT_ARRAY';
  if (flowWindow.trades.length > JUDGE_LEARNING_MAX_RAW_TRADES) return 'FLOW_TRADE_LIMIT_EXCEEDED';
  if (flowWindow.trades.length === 0) return 'EMPTY_FLOW_WINDOW_HAS_NO_MARKET_IDENTITY';
  const coverage = flowWindow.coverage;
  if (!exactKeys(coverage, COVERAGE_KEYS) || coverage.continuous !== true
      || !Number.isSafeInteger(coverage.epoch) || coverage.epoch < 0
      || !isTs(coverage.startTs) || !isTs(coverage.endTs) || coverage.startTs >= coverage.endTs
      || coverage.endTs !== decisionTs
      || !(coverage.gapTs === null || (Number.isSafeInteger(coverage.gapTs)
        && coverage.gapTs >= 0 && coverage.gapTs <= coverage.startTs))) return 'FLOW_COVERAGE_INVALID';
  let priorReceiptTs = null; let priorReceiptSequence = null;
  const identities = new Set();
  for (let index = 0; index < flowWindow.trades.length; index += 1) {
    const trade = flowWindow.trades[index];
    const error = shapeError(trade, TRADE_SCHEMA, `trade[${index}]`);
    if (error) return `FLOW_TRADE_INVALID:${error}`;
    if (trade.symbol !== request.symbol || trade.canonicalCoin !== request.canonicalCoin
        || trade.feedEpoch !== coverage.epoch || trade.fromSubscriptionSnapshot !== false) {
      return `FLOW_TRADE_${index}_MARKET_EPOCH_OR_SNAPSHOT_INVALID`;
    }
    if (trade.receiptTs > decisionTs || trade.eventTs > trade.receiptTs
        || trade.receiptTs < coverage.startTs
        || (priorReceiptTs !== null && (trade.receiptTs < priorReceiptTs
          || trade.receiptSequence <= priorReceiptSequence))) return `FLOW_TRADE_${index}_CHRONOLOGY_INVALID`;
    if (M.mul(trade.price, trade.qty) !== trade.quoteNotional) return `FLOW_TRADE_${index}_QUOTE_NOTIONAL_INVALID`;
    const identity = trade.nativeTradeId ?? `${trade.eventTs}|${trade.price}|${trade.qty}|${trade.side}`;
    if (identities.has(identity)) return `FLOW_TRADE_${index}_DUPLICATE_IDENTITY`;
    identities.add(identity);
    priorReceiptTs = trade.receiptTs; priorReceiptSequence = trade.receiptSequence;
  }
  if (bookSnapshot !== null && bookSnapshot.feedEpoch !== coverage.epoch) return 'BOOK_FLOW_EPOCH_MISMATCH';
  return null;
}

export function adaptiveJudgeFactsSourceError(input) {
  if (!exactKeys(input, TOP_KEYS)) return 'SOURCE_INPUT_SCHEMA_NOT_CLOSED';
  if (!isTs(input.decisionTs)) return 'SOURCE_DECISION_CLOCK_INVALID';
  if (Array.isArray(input.flowWindow?.trades)
      && input.flowWindow.trades.length > JUDGE_LEARNING_MAX_RAW_TRADES) return 'FLOW_TRADE_LIMIT_EXCEEDED';
  if (Array.isArray(input.historicalBars) && input.historicalBars.length > 61) return 'HISTORICAL_BARS_EXACT_61_REQUIRED';
  const bounded = boundedStructureError(input); if (bounded) return bounded;
  return marketError(input.requestedMarket, input.instrumentSpec, input.decisionTs)
    ?? bookError(input.bookSnapshot, input.requestedMarket, input.instrumentSpec, input.decisionTs)
    ?? barsError(input.frozenIndicator, input.historicalBars, input.decisionTs)
    ?? flowError(input.flowWindow, input.requestedMarket, input.bookSnapshot, input.decisionTs);
}

function sourceBindingOf(input, facts) {
  const spec = input.instrumentSpec;
  const book = input.bookSnapshot === null ? {
    state: 'UNAVAILABLE', snapshotDigest: null, instrumentDigest: null,
    receiptTs: null, sourceTs: null, feedEpoch: null, receiptSequence: null,
  } : {
    state: 'PRESENT', snapshotDigest: input.bookSnapshot.digest,
    instrumentDigest: input.bookSnapshot.instrumentDigest,
    receiptTs: input.bookSnapshot.receiptTs, sourceTs: input.bookSnapshot.sourceTs,
    feedEpoch: input.bookSnapshot.feedEpoch, receiptSequence: input.bookSnapshot.receiptSequence,
  };
  const bars = input.historicalBars === null ? {
    state: 'UNAVAILABLE', rawBarsDigest: null, preparedEvidenceDigest: null, count: 0,
    firstPeriodStartTs: null, lastPeriodEndTs: null, knownAtCeilingTs: null,
    featureVersion: null, indicatorBlockDigest: null,
  } : {
    state: 'PRESENT', rawBarsDigest: digestOf(input.historicalBars),
    preparedEvidenceDigest: facts.sourceEvidence.barEvidence.evidenceDigest,
    count: input.historicalBars.length, firstPeriodStartTs: input.historicalBars[0].periodStartTs,
    lastPeriodEndTs: input.historicalBars.at(-1).periodEndTs,
    knownAtCeilingTs: input.historicalBars.at(-1).knownAtTs,
    featureVersion: FEATURE_VERSION, indicatorBlockDigest: input.frozenIndicator.blockDigest,
  };
  const flowBytes = input.flowWindow === null ? 0 : serializedBytes(input.flowWindow);
  const flow = input.flowWindow === null ? {
    state: 'UNAVAILABLE', rawWindowDigest: null, preparedEvidenceDigest: null,
    count: 0, byteCount: 0, coverageStartTs: null, coverageEndTs: null,
    retainedGapTs: null, feedEpoch: null, firstReceiptSequence: null,
    lastReceiptSequence: null, knownAtCeilingTs: null,
  } : {
    state: 'PRESENT', rawWindowDigest: digestOf(input.flowWindow),
    preparedEvidenceDigest: facts.sourceEvidence.tradeEvidence.evidenceDigest,
    count: input.flowWindow.trades.length, byteCount: flowBytes,
    coverageStartTs: input.flowWindow.coverage.startTs,
    coverageEndTs: input.flowWindow.coverage.endTs,
    retainedGapTs: input.flowWindow.coverage.gapTs,
    feedEpoch: input.flowWindow.coverage.epoch,
    firstReceiptSequence: input.flowWindow.trades[0].receiptSequence,
    lastReceiptSequence: input.flowWindow.trades.at(-1).receiptSequence,
    knownAtCeilingTs: input.flowWindow.trades.at(-1).receiptTs,
  };
  const body = {
    sourceVersion: ADAPTIVE_JUDGE_FACTS_SOURCE_VERSION,
    decisionTs: input.decisionTs, market: clone(input.requestedMarket),
    instrument: clone(spec),
    book, bars, flow, preparedFactsDigest: facts.factsDigest,
    limitations: [...LIMITATIONS], authority: 'NONE',
  };
  const sourceDigest = digestOf(body);
  return { ...body, sourceId: `jafsrc-${sourceDigest.slice(0, 40)}`, sourceDigest };
}

export function adaptiveJudgeFactsEnvelopeError(envelope) {
  if (!exactKeys(envelope, ENVELOPE_KEYS)
      || envelope.envelopeVersion !== ADAPTIVE_JUDGE_FACTS_ENVELOPE_VERSION
      || judgeLearningPreparedFactsError(envelope.facts)) return 'ENVELOPE_OR_PREPARED_FACTS_INVALID';
  const binding = envelope.sourceBinding;
  if (!exactKeys(binding, BINDING_KEYS) || binding.sourceVersion !== ADAPTIVE_JUDGE_FACTS_SOURCE_VERSION
      || !exactKeys(binding.market, MARKET_KEYS) || instrumentSpecError(binding.instrument)
      || !exactKeys(binding.book, BOOK_KEYS) || !exactKeys(binding.bars, BARS_KEYS)
      || !exactKeys(binding.flow, FLOW_KEYS) || binding.authority !== 'NONE'
      || !Array.isArray(binding.limitations) || digestOf(binding.limitations) !== digestOf(LIMITATIONS)) {
    return 'SOURCE_BINDING_INVALID';
  }
  if (!HEX64.test(binding.sourceDigest ?? '')
      || binding.sourceId !== `jafsrc-${binding.sourceDigest.slice(0, 40)}`) return 'SOURCE_BINDING_DIGEST_INVALID';
  const body = clone(binding); delete body.sourceId; delete body.sourceDigest;
  if (digestOf(body) !== binding.sourceDigest) return 'SOURCE_BINDING_DIGEST_INVALID';
  const instrumentQuote = binding.instrument.wsname.split('/')[1] ?? null;
  if (binding.decisionTs !== envelope.facts.decisionTs
      || binding.preparedFactsDigest !== envelope.facts.factsDigest
      || binding.instrument.venue !== binding.market.venue
      || binding.instrument.wsname !== binding.market.symbol
      || binding.instrument.canonicalCoin !== binding.market.canonicalCoin
      || instrumentQuote !== binding.market.quote
      || binding.instrument.status !== 'online'
      || binding.instrument.observedTs > binding.decisionTs
      || (binding.book.state === 'PRESENT'
        && binding.instrument.specDigest !== envelope.facts.sourceEvidence.bookSnapshot?.instrumentDigest)) {
    return 'SOURCE_BINDING_INVALID';
  }
  const expectedBook = envelope.facts.sourceEvidence.bookSnapshot;
  const expectedBars = envelope.facts.sourceEvidence.barEvidence;
  const expectedFlow = envelope.facts.sourceEvidence.tradeEvidence;
  const bookMatches = expectedBook === null
    ? binding.book.state === 'UNAVAILABLE'
      && Object.entries(binding.book).every(([key, value]) => key === 'state' || value === null)
    : binding.book.state === 'PRESENT'
      && binding.book.snapshotDigest === expectedBook.digest
      && binding.book.instrumentDigest === expectedBook.instrumentDigest
      && binding.book.receiptTs === expectedBook.receiptTs
      && binding.book.sourceTs === expectedBook.sourceTs
      && binding.book.feedEpoch === expectedBook.feedEpoch
      && binding.book.receiptSequence === expectedBook.receiptSequence
      && expectedBook.priceDecimals === binding.instrument.priceDecimals
      && expectedBook.qtyDecimals === binding.instrument.qtyDecimals;
  const barsMatch = expectedBars === null
    ? binding.bars.state === 'UNAVAILABLE'
      && binding.bars.count === 0
      && Object.entries(binding.bars).every(([key, value]) => ['state', 'count'].includes(key) || value === null)
    : binding.bars.state === 'PRESENT'
      && HEX64.test(binding.bars.rawBarsDigest ?? '')
      && binding.bars.preparedEvidenceDigest === expectedBars.evidenceDigest
      && binding.bars.count === expectedBars.bars.length
      && binding.bars.firstPeriodStartTs === expectedBars.bars[0].periodStartTs
      && binding.bars.lastPeriodEndTs === expectedBars.bars.at(-1).periodEndTs
      && binding.bars.knownAtCeilingTs === expectedBars.knownAtTs.at(-1)
      && binding.bars.featureVersion === expectedBars.featureVersion
      && binding.bars.indicatorBlockDigest === envelope.facts.sourceEvidence.frozenIndicator?.blockDigest;
  const expectedRawWindow = expectedFlow === null ? null : {
    coverage: expectedFlow.coverage, trades: expectedFlow.trades,
  };
  const flowMatches = expectedFlow === null
    ? binding.flow.state === 'UNAVAILABLE'
      && binding.flow.count === 0 && binding.flow.byteCount === 0
      && Object.entries(binding.flow).every(([key, value]) => ['state', 'count', 'byteCount'].includes(key) || value === null)
    : binding.flow.state === 'PRESENT'
      && binding.flow.rawWindowDigest === digestOf(expectedRawWindow)
      && binding.flow.preparedEvidenceDigest === expectedFlow.evidenceDigest
      && binding.flow.count === expectedFlow.trades.length
      && binding.flow.byteCount === serializedBytes(expectedRawWindow)
      && binding.flow.coverageStartTs === expectedFlow.coverage.startTs
      && binding.flow.coverageEndTs === expectedFlow.coverage.endTs
      && binding.flow.retainedGapTs === expectedFlow.coverage.gapTs
      && binding.flow.feedEpoch === expectedFlow.feedEpoch
      && binding.flow.firstReceiptSequence === expectedFlow.trades[0].receiptSequence
      && binding.flow.lastReceiptSequence === expectedFlow.trades.at(-1).receiptSequence
      && binding.flow.knownAtCeilingTs === expectedFlow.knownAtCeilingTs;
  if (!bookMatches || !barsMatch || !flowMatches) return 'SOURCE_BINDING_FACT_EVIDENCE_MISMATCH';
  return null;
}

export function prepareAdaptiveJudgeFacts(input) {
  const error = adaptiveJudgeFactsSourceError(input);
  if (error) throw new TypeError(error);
  const projected = input.historicalBars === null ? null : {
    featureVersion: FEATURE_VERSION, symbol: input.requestedMarket.symbol,
    canonicalCoin: input.requestedMarket.canonicalCoin,
    bars: projectedBars(input.historicalBars),
    knownAtTs: input.historicalBars.map((bar) => bar.knownAtTs),
  };
  const facts = buildJudgeLearningPreparedFacts({
    frozen: input.frozenIndicator, decisionTs: input.decisionTs,
    bookSnapshot: input.bookSnapshot, barEvidence: projected,
    tradeEvidence: input.flowWindow,
  });
  const factsError = judgeLearningPreparedFactsError(facts);
  if (factsError) throw new TypeError(`PREPARED_FACTS_INVALID:${factsError}`);
  if (facts.marketIdentity !== null
      && (facts.marketIdentity.symbol !== input.requestedMarket.symbol
        || facts.marketIdentity.canonicalCoin !== input.requestedMarket.canonicalCoin)) {
    throw new TypeError('PREPARED_FACTS_MARKET_MISMATCH');
  }
  const envelope = deepFreeze({
    envelopeVersion: ADAPTIVE_JUDGE_FACTS_ENVELOPE_VERSION,
    facts, sourceBinding: sourceBindingOf(input, facts),
  });
  const envelopeError = adaptiveJudgeFactsEnvelopeError(envelope);
  if (envelopeError) throw new TypeError(envelopeError);
  return envelope;
}
