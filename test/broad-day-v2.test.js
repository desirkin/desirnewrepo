import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2,
  broadKrakenRecordError,
  broadKrakenRecordIdOf,
  startBroadKraken,
} from '../market-lab/broad-kraken.js';
import {
  BROAD_DAY_ARCHIVE_VERSION_V2,
  openBroadDayArchive,
} from '../market-lab/broad-day-archive.js';
import { openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const MINUTE = 60_000;
const DAY = Date.parse('2026-09-13T00:00:00.000Z');
const END = DAY + 24 * 60 * MINUTE;
const roots = [];
const makeRoot = (name) => {
  const root = mkdtempSync(path.join(tmpdir(), `broad-v2-${name}-`)); roots.push(root); return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

class FakeSocket {
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text) { this.sent.push(JSON.parse(text)); }
  emit(body) { this.onmessage?.({ data: JSON.stringify(body) }); }
  close() { this.readyState = 3; this.onclose?.({}); }
}

function manualTimers() {
  const queue = []; const intervals = new Set();
  const later = (fn) => { const token = { fn, cleared: false }; queue.push(token); return token; };
  return {
    setTimeout: (fn) => later(fn), clearTimeout: (token) => { if (token) token.cleared = true; },
    setInterval: (fn) => { const token = { fn, cleared: false, unref() {} }; intervals.add(token); return token; },
    clearInterval: (token) => { if (token) token.cleared = true; intervals.delete(token); },
    runAll(limit = 1_000) { let n = 0; while (queue.length) { const token = queue.shift(); if (!token.cleared) token.fn(); if (++n > limit) throw new Error('timer runaway'); } },
  };
}

function catalogAt(observedTs, { eth = false } = {}) {
  const normalized = normalizeKrakenAssetPairs({
    XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
    ...(eth ? { XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' } } : {}),
  }, { observedTs });
  assert.equal(normalized.ok, true); return normalized.catalog;
}

function marketOf(catalog, coin = 'BTC') {
  const market = catalog.markets.find((row) => row.base === coin);
  return {
    canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
    catalogWsname: market.wsname, wsSymbol: market.wsname,
  };
}

function candle(catalog, periodStartTs, sequence, { coin = 'BTC', close = 101 } = {}) {
  const receivedTs = periodStartTs + MINUTE + 500;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'source-v2-session', sequence, recordType: 'OHLC', recordedTs: receivedTs + 10,
    catalogContentId: catalog.contentId, epochId: 'source-v2-epoch', market: marketOf(catalog, coin),
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, receivedTs,
    periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      volumeBase: 4, trades: 3, vwap: 100.5, close,
      low: 99, high: Math.max(102, close), open: 100,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null);
  return Object.freeze(record);
}

function controlsFile(root, index = 0) {
  const session = readdirSync(path.join(root, 'sessions')).sort()[index];
  return path.join(root, 'sessions', session, 'controls.jsonl');
}

test('v2 canonical identities survive canonical archive storage and complete bounded heartbeat/finalization proof', { timeout: 30_000 }, async () => {
  const root = makeRoot('complete'); let now = DAY - MINUTE; let sequence = 0;
  const archive = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now, limits: { fsyncEveryEntries: 64 } });
  let catalog = catalogAt(now);
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = DAY + minute * MINUTE + 520;
      catalog = catalogAt(now);
      const heartbeat = archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
      assert.equal(heartbeat.accepted, true); assert.equal(archive.status().counters.catalogHeartbeats, minute / 15);
    }
    const row = candle(catalog, DAY + minute * MINUTE, ++sequence, { close: 100 + minute / 10_000 });
    now = row.recordedTs;
    assert.equal(archive.tryAcceptRecord(row).accepted, true);
  }
  now = END + 520; catalog = catalogAt(now);
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  const finalized = archive.finalize({ cutoffTs: now });
  assert.equal(finalized.accepted, true); assert.equal(archive.tryAcceptRecord(candle(catalog, END, ++sequence)).code, 'ARCHIVE_FINALIZED');
  await archive.drain();
  assert.equal(archive.status().claims.finalized, true);
  await archive.close();

  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  assert.equal(reader.descriptor.archiveVersion, BROAD_DAY_ARCHIVE_VERSION_V2);
  assert.equal(reader.descriptor.completeness.sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite, true);
  assert.equal(reader.descriptor.completeness.sessionFinalizationVerified, true);
  assert.equal(reader.descriptor.completeness.catalogEpochContinuityVerified, true);
  assert.equal(reader.descriptor.completeness.fullPopulationVerified, true);
  assert.equal(reader.descriptor.completeness.fullDaySimulationReady, true);
  assert.equal(reader.descriptor.coverage.length, 1);
  assert.equal(reader.descriptor.coverage[0].expectedCatalogMembershipMinutes, 1_440);
  assert.equal(reader.descriptor.coverage[0].uniqueObservedMinutes, 1_440);
  const first = await reader.readPage({ maxRows: 700 });
  const second = await reader.readPage({ cursor: first.nextCursor, maxRows: 700 });
  const third = await reader.readPage({ cursor: second.nextCursor, maxRows: 700 });
  assert.deepEqual([first.rows.length, second.rows.length, third.rows.length], [700, 700, 40]);
  assert.equal(third.done, true); assert.ok(first.rows.every((row) => row.recordId.startsWith('bkr2-')));
  reader.close();
});

test('v1 and v2 identities are explicit and v2 is stable across key insertion order', () => {
  const catalog = catalogAt(DAY - MINUTE);
  const one = candle(catalog, DAY, 1);
  const reordered = {
    payload: { ...one.payload }, periodEndTs: one.periodEndTs, periodStartTs: one.periodStartTs,
    receivedTs: one.receivedTs, sourceEventTs: one.sourceEventTs, quality: one.quality,
    channel: one.channel, market: { ...one.market }, epochId: one.epochId,
    catalogContentId: one.catalogContentId, recordedTs: one.recordedTs, recordType: one.recordType,
    sequence: one.sequence, sessionId: one.sessionId, recordId: one.recordId, recordVersion: one.recordVersion,
  };
  assert.equal(broadKrakenRecordIdOf(reordered), one.recordId);
  assert.equal(broadKrakenRecordError(reordered), null);
});

test('the real broad collector mints opt-in v2 identities before its local writer and callback', async () => {
  FakeSocket.instances.length = 0; const dataDir = makeRoot('producer'); const timers = manualTimers();
  const catalog = catalogAt(DAY); const captured = [];
  const handle = startBroadKraken({
    catalogSource: { snapshot: () => ({ catalog, fresh: true }) }, dataDir,
    WebSocketImpl: FakeSocket, clock: () => DAY + MINUTE, timers,
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, onRecord: (record) => captured.push(record),
    limits: { catalogPollMs: 60_000 },
  });
  try {
    const socket = FakeSocket.instances[0]; socket.open();
    const request = socket.sent.find((row) => row.params?.channel === 'instrument');
    socket.emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: 'instrument' } });
    socket.emit({ channel: 'instrument', type: 'snapshot', data: { assets: [], pairs: [{ symbol: 'XBT/USD', base: 'XBT', quote: 'USD', status: 'online' }] } });
    timers.runAll(); await handle.drain();
    assert.ok(captured.length > 0);
    assert.ok(captured.every((record) => record.recordVersion === BROAD_KRAKEN_RECORD_VERSION_V2
      && record.recordId === broadKrakenRecordIdOf(record) && broadKrakenRecordError(record) === null));
  } finally { await handle.stop(); }
});

test('a closed v2 session without finalization and a finalized session without heartbeat cadence remain incomplete', async () => {
  for (const [name, shouldFinalize] of [['crash', false], ['no-heartbeats', true]]) {
    const root = makeRoot(name); let now = DAY - MINUTE; const catalog = catalogAt(now);
    const archive = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
    archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
    const row = candle(catalog, DAY, 1); now = row.recordedTs; archive.tryAcceptRecord(row);
    if (shouldFinalize) { now = END; archive.finalize({ cutoffTs: now }); }
    await archive.close();
    const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
    assert.equal(reader.descriptor.completeness.fullDaySimulationReady, false);
    assert.equal(reader.descriptor.completeness.sessionFinalizationVerified, shouldFinalize);
    assert.equal(reader.descriptor.completeness.catalogEpochContinuityVerified, false);
    reader.close();
  }
});

test('post-day catalog change never enters the completed-day union even when final asOf is later', async () => {
  const root = makeRoot('post-day'); let now = DAY - MINUTE;
  const archive = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  const btc = catalogAt(now); archive.tryAcceptCatalog({ catalog: btc, sourceObservedTs: now, knownAtTs: now });
  now = END + MINUTE; const changed = catalogAt(now, { eth: true });
  archive.tryAcceptCatalog({ catalog: changed, sourceObservedTs: now, knownAtTs: now });
  archive.finalize({ cutoffTs: now }); await archive.close();
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + 2 * MINUTE });
  assert.deepEqual(reader.descriptor.catalogUnion.map((row) => row.market.canonicalCoin), ['BTC']);
  assert.ok(reader.descriptor.catalogEpochs.every((row) => row.admittedTs < END));
  reader.close();
});

test('an in-day v2 catalog change preserves membership boundaries instead of demanding a full-day grid from a new member', async () => {
  const root = makeRoot('in-day-churn'); let now = DAY - MINUTE;
  const archive = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  let catalog = catalogAt(now); archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  for (let minute = 15; minute <= 1_440; minute += 15) {
    now = DAY + minute * MINUTE;
    catalog = catalogAt(now, { eth: minute >= 720 });
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  }
  archive.finalize({ cutoffTs: now }); await archive.close();
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  const byCoin = Object.fromEntries(reader.descriptor.coverage.map((row) => [row.market.canonicalCoin, row]));
  assert.equal(byCoin.BTC.expectedCatalogMembershipMinutes, 1_440);
  assert.equal(byCoin.ETH.expectedCatalogMembershipMinutes, 720);
  assert.equal(reader.descriptor.completeness.catalogEpochContinuityVerified, true);
  assert.equal(reader.descriptor.completeness.sessionFinalizationVerified, true);
  assert.equal(reader.descriptor.completeness.fullDaySimulationReady, false);
  reader.close();
});

test('contradictory v2 record identity and tampered or truncated finalization refuse', async () => {
  const conflictRoot = makeRoot('identity-conflict'); let now = DAY - MINUTE; const catalog = catalogAt(now);
  const archive = openBroadDayArchive({ rootDir: conflictRoot, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  const row = candle(catalog, DAY, 1); now = row.recordedTs; assert.equal(archive.tryAcceptRecord(row).accepted, true);
  const contradictory = { ...row, payload: { ...row.payload, close: row.payload.close + 1 } };
  assert.equal(archive.tryAcceptRecord(contradictory).accepted, false);
  assert.equal(archive.status().failure.code, 'ARCHIVE_RECORD_INVALID');
  await assert.rejects(archive.close());

  const buildFinalized = async (name) => {
    const root = makeRoot(name); let clock = DAY - MINUTE; const c = catalogAt(clock);
    const writer = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => clock });
    writer.tryAcceptCatalog({ catalog: c, sourceObservedTs: clock, knownAtTs: clock });
    clock = END; writer.finalize({ cutoffTs: clock }); await writer.close(); return root;
  };
  const tampered = await buildFinalized('tampered-final'); const tamperedFile = controlsFile(tampered);
  const lines = readFileSync(tamperedFile, 'utf8').trimEnd().split('\n');
  const final = JSON.parse(lines.at(-1)); final.cutoffTs -= 1; lines[lines.length - 1] = JSON.stringify(final);
  writeFileSync(tamperedFile, `${lines.join('\n')}\n`);
  await assert.rejects(openBroadDayReader({ rootDir: tampered, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE }), (error) => ['READER_CANONICAL_MISMATCH', 'READER_CONTROL_INVALID', 'READER_FINALIZATION_INVALID'].includes(error.code));

  const truncated = await buildFinalized('truncated-final'); const truncatedFile = controlsFile(truncated);
  const text = readFileSync(truncatedFile, 'utf8'); writeFileSync(truncatedFile, text.slice(0, -1));
  await assert.rejects(openBroadDayReader({ rootDir: truncated, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE }), (error) => error.code === 'READER_TRUNCATED_TAIL');
});

test('a restart gap and a catalog first learned after a candle period remain explicit non-eligibility', async () => {
  const root = makeRoot('restart-gap'); let now = DAY - MINUTE; let catalog = catalogAt(now);
  const first = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  first.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  now = DAY + 10 * MINUTE; first.finalize({ cutoffTs: now }); await first.close();
  now += MINUTE; catalog = catalogAt(now);
  const second = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  second.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  const late = candle(catalog, DAY + 10 * MINUTE, 1); now = Math.max(now, late.recordedTs); second.tryAcceptRecord(late);
  now = END; second.finalize({ cutoffTs: now }); await second.close();
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  assert.equal(reader.descriptor.completeness.sessionFinalizationVerified, false);
  assert.equal(reader.descriptor.counters.catalogAsOfWithheldRows, 1);
  assert.equal(reader.descriptor.counters.asOfEligibleCivilDayRows, 0);
  assert.ok(reader.descriptor.completeness.reasons.includes('CANDLE_CATALOG_MEMBERSHIP_NOT_KNOWN_AT_PERIOD_START'));
  reader.close();
});
