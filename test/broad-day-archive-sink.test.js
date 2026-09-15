// DATA-1 sink (2026-09-15): the broad-day-archive sink opens the day archive, admits the accepted catalog, feeds the
// broad-Kraken collector's records into it, finalizes + re-opens at the civil-day boundary, and stays fail-closed. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordError, broadKrakenRecordIdOf } from '../market-lab/broad-kraken.js';
import { openBroadDayArchive, BROAD_DAY_ARCHIVE_VERSION_V2 } from '../market-lab/broad-day-archive.js';
import { createBroadDayArchiveSink, broadDayArchiveEnabled, BROAD_DAY_ARCHIVE_DIRNAME } from '../market-lab/broad-day-archive-sink.js';

const MINUTE = 60_000;
const DAY = Date.parse('2026-09-13T00:00:00.000Z');
const roots = [];
const makeRoot = (name) => { const r = mkdtempSync(path.join(tmpdir(), `sink-${name}-`)); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const CATALOG = (() => { const n = normalizeKrakenAssetPairs({ XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' } }, { observedTs: DAY - MINUTE }); assert.equal(n.ok, true); return n.catalog; })();
const marketOf = (coin = 'BTC') => { const m = CATALOG.markets.find((x) => x.base === coin); return { canonicalCoin: m.base, pairKey: m.pairKey, nativeBase: m.nativeBase, catalogWsname: m.wsname, wsSymbol: m.wsname }; };
function candle(periodStartTs, sequence, { quality = 'CONSERVATIVE_CLOSED', close = 101 } = {}) {
  const receivedTs = periodStartTs + MINUTE + 500;
  const provisional = quality === 'PROVISIONAL';
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null, sessionId: 'src-session', sequence, recordType: 'OHLC',
    recordedTs: receivedTs + 10, catalogContentId: CATALOG.contentId, epochId: 'src-epoch', market: marketOf(), channel: 'ohlc',
    quality, sourceEventTs: null, receivedTs, periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: { volumeBase: 4, trades: 3, vwap: 100.5, close, low: 99, high: Math.max(102, close), open: 100, learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', finality: provisional ? 'PROVISIONAL' : 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: provisional ? 'provisional' : 'closed' },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null, `record ${quality} is well-formed`);
  return Object.freeze(record);
}

test('DAS-1. the sink admits the catalog, archives closed candles, excludes provisional/ticker, rolls the day (finalize + reopen) and releases the lock on stop', async () => {
  const root = makeRoot('vertical');
  const BOUNDARY = DAY + 12 * 60 * MINUTE;
  let now = DAY - MINUTE + 100;
  const catalogSource = { snapshot: () => ({ catalog: CATALOG }) };
  const dayLabelOf = (t) => (t < BOUNDARY ? 'DAY_A' : 'DAY_B');
  const sink = createBroadDayArchiveSink({ root, catalogSource, clock: () => now, dayLabelOf, rollCheckMs: 60_000 });

  let s = sink.status();
  assert.equal(s.currentDay, 'DAY_A'); assert.equal(s.dark, null);
  assert.equal(s.counters.catalogAdmits, 1, 'the accepted catalog is admitted at open');
  assert.equal(s.counters.catalogContentId, CATALOG.contentId);

  // two closed candles are archived; a provisional candle is intentionally excluded (not a fault)
  for (const [i, ps] of [DAY, DAY + MINUTE].entries()) { const c = candle(ps, i + 1); now = c.recordedTs + 50; sink.onRecord(c); }
  const prov = candle(DAY + 2 * MINUTE, 3, { quality: 'PROVISIONAL' }); now = prov.recordedTs + 50; sink.onRecord(prov);
  s = sink.status();
  assert.equal(s.counters.accepted, 2, 'two closed candles archived'); assert.equal(s.counters.ineligible, 1, 'the provisional candle is excluded, not archived'); assert.equal(s.counters.faults, 0);

  // cross the civil-day boundary: the roll finalizes the day-A session and opens a fresh day-B session
  now = BOUNDARY + 100; await sink.rollIfNeeded(now);
  s = sink.status();
  assert.equal(s.counters.rolls, 1, 'the day boundary rolled the session'); assert.equal(s.currentDay, 'DAY_B'); assert.equal(s.dark, null);
  assert.equal(readdirSync(path.join(root, BROAD_DAY_ARCHIVE_DIRNAME, 'sessions')).length, 2, 'the finalized day-A session persists beside the new day-B session');

  // the new session accepts a fresh candle
  const d2 = candle(BOUNDARY, 4); now = d2.recordedTs + 50; sink.onRecord(d2);
  assert.equal(sink.status().counters.accepted, 3, 'the new session archives the next day\'s candle');

  // stop finalizes and releases the writer.lock — a fresh archive can now open the same root
  now += 1000; const stopped = await sink.stop();
  assert.equal(stopped.closed, true); assert.equal(stopped.dark, null);
  assert.ok(!existsSync(path.join(root, BROAD_DAY_ARCHIVE_DIRNAME, 'writer.lock')), 'the writer.lock is released on stop');
  const reopened = openBroadDayArchive({ rootDir: path.join(root, BROAD_DAY_ARCHIVE_DIRNAME), formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now });
  await reopened.close();
});

test('DAS-2. an archive fault latches the sink DARK and can never break capture: onRecord swallows and counts, never throws', async () => {
  const root = makeRoot('fault');
  let now = DAY;
  // a fake archive whose record write throws — the sink must catch it, go dark, and keep accepting (dropping) calls
  const fakeArchive = { tryAcceptCatalog: () => ({ accepted: true }), tryAcceptRecord: () => { throw new Error('disk exploded'); }, finalize: () => ({ accepted: false, fatal: false }), drain: async () => {}, close: async () => {}, status: () => ({}) };
  const sink = createBroadDayArchiveSink({ root, catalogSource: { snapshot: () => ({ catalog: CATALOG }) }, clock: () => now, dayLabelOf: () => 'D', openArchive: () => fakeArchive });
  assert.doesNotThrow(() => sink.onRecord(candle(DAY, 1)), 'a throwing archive never propagates into capture');
  const s = sink.status();
  assert.ok(s.dark, 'the sink latched dark'); assert.equal(s.dark.code, 'ARCHIVE_RECORD_THREW'); assert.equal(s.counters.faults, 1);
  // further records are silently dropped (counted), still no throw
  assert.doesNotThrow(() => sink.onRecord(candle(DAY + MINUTE, 2)));
  assert.equal(sink.status().counters.skipped, 1, 'records after the fault are dropped, counted');
  await sink.stop();
});

test('DAS-3. the sink is opt-in: broadDayArchiveEnabled reads SERPENT_BROAD_DAY_ARCHIVE, default OFF', () => {
  assert.equal(broadDayArchiveEnabled({}), false);
  assert.equal(broadDayArchiveEnabled({ SERPENT_BROAD_DAY_ARCHIVE: 'false' }), false);
  assert.equal(broadDayArchiveEnabled({ SERPENT_BROAD_DAY_ARCHIVE: 'true' }), true);
});
