import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareDailyBroadInput } from '../learning/daily-broad-input.js';
import { buildDailyMoveStudy, sealDailyMoveStudyManifest } from '../learning/daily-move-study.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 8, 13, 4); // midnight America/New_York (EDT)
const END = START + 24 * HOUR;
const FINAL = END + HOUR;
const MARKET_KEYS = ['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const rawMarket = (base, pairKey = `${base}USD`) => ({ pairKey, nativeBase: `X${base}`, nativeQuote: 'ZUSD', wsname: `${base}/USD`, base, quote: 'USD', status: 'online' });
function catalog(markets = [rawMarket('BTC'), rawMarket('ETH')]) {
  const out = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: START + 1, contentId: '', markets };
  const selected = markets.map((market) => Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  out.contentId = createHash('sha1').update(canonicalJson({ venue: out.venue, quote: out.quote, policyVersion: out.policyVersion, markets: selected })).digest('hex');
  return out;
}

const tickerPayload = (eventTs, price = 100) => ({
  messageType: 'update', lastPrice: price, bid: price - 1, ask: price + 1, bidQty: 2, askQty: 3,
  change24h: 1, changePct24h: 1, high24h: price + 5, low24h: price - 5,
  volume24hBase: 1000, vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
});
const candlePayload = (price = 100) => ({
  messageType: 'closed', finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL',
  sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', learningEligible: false,
  open: price, high: price + 1, low: price - 1, close: price, vwap: price, trades: 1, volumeBase: 2,
});

function sealRecord({
  seq, market = rawMarket('BTC'), sessionId = 'bks-session-1', epochId = 'epoch-1',
  recordType = 'TICKER', channel = 'ticker', quality = 'OBSERVED',
  receivedTs = START + HOUR + 20, recordedTs = receivedTs + 1,
  sourceEventTs = START + HOUR + 10, periodStartTs = null, periodEndTs = null,
  payload = tickerPayload(sourceEventTs), catalogContentId = CATALOG.contentId,
} = {}) {
  const record = {
    recordVersion: 'broad-kraken-record-v1', recordId: null, sessionId, sequence: seq,
    recordType, recordedTs, catalogContentId, epochId,
    market: { canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase, catalogWsname: market.wsname, wsSymbol: market.wsname },
    channel, quality, sourceEventTs, receivedTs, periodStartTs, periodEndTs, payload,
  };
  record.recordId = `bkr-${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
  return record;
}

function resealRecord(record) {
  const copy = structuredClone(record);
  copy.recordId = null;
  copy.recordId = `bkr-${createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
  return copy;
}

const CATALOG = catalog();
const baseInput = (records, extra = {}) => ({
  catalog: CATALOG, records, dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
  captureStartTs: START, captureEndTs: FINAL, truncated: false, ...extra,
});

test('valid bounded capture maps the proven catalog to every planner row and stays explicit about incomplete families', () => {
  const ticker = sealRecord({ seq: 1 });
  const periodStartTs = START + 2 * HOUR;
  const candle = sealRecord({
    seq: 2, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED',
    sourceEventTs: null, periodStartTs, periodEndTs: periodStartTs + MINUTE,
    receivedTs: periodStartTs + MINUTE + 20, payload: candlePayload(),
  });
  const result = prepareDailyBroadInput(baseInput([ticker, candle]));
  assert.equal(result.ok, true);
  assert.equal(result.acceptedCatalogSnapshot.acceptedMarketCount, 2);
  assert.equal(result.marketDays.length, 2);
  const btc = result.marketDays.find((row) => row.priceEvents.length === 1);
  assert.equal(btc.candles.length, 1);
  assert.equal(btc.support.PRICE.state, 'PARTIAL');
  assert.equal(btc.support.CANDLES.state, 'GAP');
  assert.equal(btc.support.BASE_VOLUME.observedCount, 1);
  for (const family of ['QUOTE_VOLUME', 'TRADES', 'TRADE_FLOW', 'SPREAD', 'DEPTH', 'CATALYST']) assert.equal(btc.support[family].state, 'UNSUPPORTED');
  assert.equal(result.diagnostics.fullDayCatalogEpochUnionVerified, false);
  assert.equal(result.diagnostics.persistedRecordContinuityVerified, false);
  assert.equal(result.diagnostics.mode, 'BOUNDED_PARTIAL_CAPTURE_ONLY');
  assert.equal(result.diagnostics.inputByteBasis, 'VALIDATED_CATALOG_PROJECTION_PLUS_RECORD_WIRE_UTF8_BYTES');
  assert.equal(result.diagnostics.fullDetailClaimed, false);

  const manifest = sealDailyMoveStudyManifest({
    createdTs: FINAL, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: result.acceptedCatalogSnapshot,
  });
  const study = buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot: result.acceptedCatalogSnapshot, marketDays: result.marketDays });
  assert.equal(study.cases.length, 2, 'adapter output is accepted without shrinking the denominator');
  assert.equal(study.counters.completedSimulations, 0);
});

test('truncation and aggregate UTF-8 byte/row limits refuse the whole input', () => {
  const record = sealRecord({ seq: 1 });
  const good = prepareDailyBroadInput(baseInput([record]));
  assert.equal(good.ok, true);
  const truncated = prepareDailyBroadInput(baseInput([record], { truncated: true }));
  assert.deepEqual(Object.keys(truncated).sort(), ['detail', 'ok', 'reason']);
  assert.equal(truncated.reason, 'CAPTURE_TRUNCATED');
  assert.equal(prepareDailyBroadInput(baseInput([record], { limits: { maxInputBytes: good.diagnostics.inputBytes - 1 } })).reason, 'INPUT_BYTE_LIMIT');
  assert.equal(prepareDailyBroadInput(baseInput([record], { limits: { maxRecords: 1 }, records: [record, sealRecord({ seq: 2 })] })).reason, 'RECORD_LIMIT');
});

test('record wire, bounded payload, and incremental per-market observation limits refuse before partial output', () => {
  const record = sealRecord({ seq: 1 });
  assert.equal(prepareDailyBroadInput(baseInput([record], { limits: { maxRecordBytes: 200 } })).reason, 'RECORD_WIRE_LIMIT');

  const oversizedList = sealRecord({
    seq: 2,
    payload: { ...tickerPayload(START + HOUR + 10), missingFields: Array(33).fill('bounded-name') },
  });
  assert.equal(prepareDailyBroadInput(baseInput([oversizedList])).reason, 'RECORD_INVALID');

  const second = sealRecord({
    seq: 2,
    sourceEventTs: START + 2 * HOUR,
    receivedTs: START + 2 * HOUR + 1,
    recordedTs: START + 2 * HOUR + 2,
    payload: tickerPayload(START + 2 * HOUR, 101),
  });
  const capped = prepareDailyBroadInput(baseInput([record, second], { limits: { maxObservationsPerMarket: 1 } }));
  assert.deepEqual(Object.keys(capped).sort(), ['detail', 'ok', 'reason']);
  assert.equal(capped.reason, 'MARKET_OBSERVATION_LIMIT');
});

test('catalog digest forgery, churn, unknown markets, and hidden payload fields are never accepted as a partial prefix', () => {
  const forgedCatalog = structuredClone(CATALOG); forgedCatalog.contentId = 'f'.repeat(40);
  assert.equal(prepareDailyBroadInput(baseInput([], { catalog: forgedCatalog })).reason, 'CATALOG_INVALID');

  const churn = sealRecord({ seq: 1, catalogContentId: 'e'.repeat(40) });
  assert.equal(prepareDailyBroadInput(baseInput([churn])).reason, 'CATALOG_CHURN_OR_UNKNOWN_MARKET');

  const stranger = rawMarket('SOL');
  const unknown = sealRecord({ seq: 2, market: stranger });
  assert.equal(prepareDailyBroadInput(baseInput([unknown])).reason, 'CATALOG_CHURN_OR_UNKNOWN_MARKET');

  const poisoned = sealRecord({ seq: 3, payload: { ...tickerPayload(START + HOUR + 10), retrospectiveWinner: true } });
  assert.equal(prepareDailyBroadInput(baseInput([poisoned])).reason, 'RECORD_INVALID');
});

test('identity fields require JSON strings even when coercion could stringify a one-element array', () => {
  const arraySession = sealRecord({ seq: 1 });
  arraySession.sessionId = ['bks-session-1'];
  assert.equal(prepareDailyBroadInput(baseInput([resealRecord(arraySession)])).reason, 'RECORD_INVALID');

  const arraySymbol = sealRecord({ seq: 2 });
  arraySymbol.market.wsSymbol = ['BTC/USD'];
  assert.equal(prepareDailyBroadInput(baseInput([resealRecord(arraySymbol)])).reason, 'CATALOG_CHURN_OR_UNKNOWN_MARKET');
});

test('midday starts, early tails, explicit gaps, restarts, and epoch changes can only downgrade support', () => {
  const first = sealRecord({ seq: 1, receivedTs: START + 3 * HOUR, recordedTs: START + 3 * HOUR + 1, sourceEventTs: START + 3 * HOUR - 1, payload: tickerPayload(START + 3 * HOUR - 1) });
  const second = sealRecord({ seq: 1, sessionId: 'bks-session-2', epochId: 'epoch-2', receivedTs: START + 4 * HOUR, recordedTs: START + 4 * HOUR + 1, sourceEventTs: START + 4 * HOUR - 1, payload: tickerPayload(START + 4 * HOUR - 1, 101) });
  const gap = sealRecord({
    seq: 2, sessionId: 'bks-session-2', epochId: 'epoch-2', recordType: 'GAP', channel: 'ticker', quality: 'GAP',
    receivedTs: START + 5 * HOUR, recordedTs: START + 5 * HOUR + 1, sourceEventTs: null,
    payload: { state: 'GAP', reason: 'SOCKET_CLOSED', epochId: 'epoch-2' },
  });
  const result = prepareDailyBroadInput(baseInput([first, second, gap], { captureStartTs: START + 2 * HOUR, captureEndTs: END - HOUR }));
  assert.equal(result.ok, true);
  const btc = result.marketDays.find((row) => row.priceEvents.length === 2);
  assert.equal(btc.support.PRICE.state, 'GAP');
  assert.match(btc.support.PRICE.reason, /CAPTURE_STARTED_AFTER_DAY_START/);
  assert.match(btc.support.PRICE.reason, /CAPTURE_ENDED_BEFORE_DAY_END/);
  assert.match(btc.support.PRICE.reason, /SESSION_RESTART/);
  assert.match(btc.support.PRICE.reason, /FEED_EPOCH_CHANGE/);
  assert.match(btc.support.PRICE.reason, /EXPLICIT_TICKER_GAP/);
});

test('a candle closed after the day is retained only when it was known by the declared finalization clock', () => {
  const periodStartTs = END - MINUTE;
  const late = sealRecord({
    seq: 1, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
    periodStartTs, periodEndTs: END, receivedTs: END + 5 * MINUTE, recordedTs: END + 5 * MINUTE + 1,
    payload: candlePayload(110),
  });
  const result = prepareDailyBroadInput(baseInput([late], { captureEndTs: END + 10 * MINUTE, finalizedTs: END + 10 * MINUTE }));
  assert.equal(result.ok, true);
  assert.equal(result.marketDays.find((row) => row.candles.length).candles[0].knownAtTs, END + 5 * MINUTE + 1);

  const afterFinal = sealRecord({
    seq: 2, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
    periodStartTs, periodEndTs: END, receivedTs: END + 5 * MINUTE, recordedTs: END + 11 * MINUTE,
    payload: candlePayload(110),
  });
  assert.equal(prepareDailyBroadInput(baseInput([afterFinal], { captureEndTs: END + 10 * MINUTE, finalizedTs: END + 10 * MINUTE })).reason, 'RECORD_INVALID');
});

test('duplicate durable identities, session sequences, and closed candle periods refuse the whole day', () => {
  const record = sealRecord({ seq: 1 });
  assert.equal(prepareDailyBroadInput(baseInput([record, record])).reason, 'DUPLICATE_RECORD');
  const sameSequence = sealRecord({ seq: 1, sourceEventTs: START + 2 * HOUR, receivedTs: START + 2 * HOUR + 1, payload: tickerPayload(START + 2 * HOUR) });
  assert.equal(prepareDailyBroadInput(baseInput([record, sameSequence])).reason, 'DUPLICATE_RECORD');

  const periodStartTs = START + 4 * HOUR;
  const a = sealRecord({ seq: 2, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, periodStartTs, periodEndTs: periodStartTs + MINUTE, receivedTs: periodStartTs + MINUTE + 1, payload: candlePayload(100) });
  const b = sealRecord({ seq: 3, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, periodStartTs, periodEndTs: periodStartTs + MINUTE, receivedTs: periodStartTs + MINUTE + 2, payload: candlePayload(101) });
  assert.equal(prepareDailyBroadInput(baseInput([a, b])).reason, 'DUPLICATE_CANDLE_PERIOD');
});

test('within a bounded single-market fixture, only an exact direct 1-minute grid can earn complete candle/base-volume support', () => {
  const one = catalog([rawMarket('BTC')]);
  const records = Array.from({ length: 24 * 60 }, (_, i) => {
    const periodStartTs = START + i * MINUTE;
    return sealRecord({
      seq: i + 1, recordType: 'OHLC', channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
      periodStartTs, periodEndTs: periodStartTs + MINUTE, receivedTs: periodStartTs + MINUTE + 1,
      recordedTs: periodStartTs + MINUTE + 2, payload: candlePayload(100 + i / 1000), catalogContentId: one.contentId,
    });
  });
  const complete = prepareDailyBroadInput(baseInput(records, { catalog: one }));
  assert.equal(complete.ok, true);
  assert.equal(complete.marketDays[0].support.CANDLES.state, 'COMPLETE');
  assert.equal(complete.marketDays[0].support.BASE_VOLUME.state, 'COMPLETE');
  assert.equal(complete.marketDays[0].support.PRICE.state, 'MISSING');

  const missingMinute = prepareDailyBroadInput(baseInput(records.slice(1), { catalog: one }));
  assert.equal(missingMinute.ok, true);
  assert.equal(missingMinute.marketDays[0].support.CANDLES.state, 'GAP');
});

test('future/malformed clocks and unsupported record kinds refuse rather than disappear', () => {
  const futureClock = sealRecord({ seq: 1, sourceEventTs: START + HOUR + 30, receivedTs: START + HOUR + 20, payload: tickerPayload(START + HOUR + 30) });
  assert.equal(prepareDailyBroadInput(baseInput([futureClock])).reason, 'RECORD_INVALID');
  const unknown = sealRecord({ seq: 2, recordType: 'TRADE', channel: 'trade', sourceEventTs: null, payload: {} });
  assert.equal(prepareDailyBroadInput(baseInput([unknown])).reason, 'RECORD_INVALID');
});
