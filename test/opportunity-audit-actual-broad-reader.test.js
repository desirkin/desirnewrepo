import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBroadDayArchive, BROAD_DAY_ARCHIVE_VERSION_V2 } from '../market-lab/broad-day-archive.js';
import { openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordIdOf } from '../market-lab/broad-kraken.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { sealAuditFrameV2 } from '../learning/opportunity-audit.js';
import { opportunityAuditPendingItemV2, opportunityAuditBroadDaySourceReceiptError } from '../learning/opportunity-audit-followup.js';
import { createOpportunityAuditBroadDayOutcomeSource } from '../learning/opportunity-audit-broad-day-outcome-source.js';

const MIN = 60_000;
const DAY = Date.UTC(2026, 8, 13);
const END = DAY + 1440 * MIN;
function catalogAt(observedTs) {
  const result = normalizeKrakenAssetPairs({ XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' } }, { observedTs });
  assert.equal(result.ok, true); return result.catalog;
}
function request(asOfTs) {
  const frameTs = END - 60 * MIN;
  const frame = sealAuditFrameV2({ catalog: catalogAt(frameTs), frameTs, knownAtTs: frameTs, sampleSize: 1, horizonsMs: [60 * MIN], maxLabelDelayMs: 2 * MIN, seedHex: '7a'.repeat(32) });
  const entry = frame.population[0];
  const item = opportunityAuditPendingItemV2(frame, {
    cursor: 'actual-reader-1', frameId: frame.frameId, frameDigest: frame.frameDigest,
    opportunityId: entry.opportunityId, canonicalCoin: entry.market.base, horizonMs: 60 * MIN,
    dueTs: END, lastOutcomeId: null, lastStatus: null, annotationPresent: false,
    observationInclusionProbability: entry.observationInclusionProbability, actionPropensity: entry.actionPropensity,
  });
  return { followupVersion: 'opportunity-audit-followup-2', item, frame, annotation: null, asOfTs };
}
test('actual V2 writer -> actual paged reader -> audit source produces exact matured receipt after finalization', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-actual-reader-'));
  let now = DAY - MIN;
  const archive = openBroadDayArchive({ rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now, limits: { fsyncEveryEntries: 64 } });
  try {
    let catalog = catalogAt(now);
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    for (let minute = 0; minute < 1440; minute += 1) {
      if (minute && minute % 15 === 0) {
        now = DAY + minute * MIN + 520; catalog = catalogAt(now);
        assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
      }
      const periodStartTs = DAY + minute * MIN;
      const market = catalog.markets[0]; const receivedTs = periodStartTs + MIN + 500;
      const close = 100 + minute / 100;
      const record = {
        recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null, sessionId: 'source-actual-v2', sequence: minute + 1,
        recordType: 'OHLC', recordedTs: receivedTs + 10, catalogContentId: catalog.contentId, epochId: 'actual-epoch',
        market: { canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase, catalogWsname: market.wsname, wsSymbol: market.wsname },
        channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, receivedTs, periodStartTs, periodEndTs: periodStartTs + MIN,
        payload: { volumeBase: 4, trades: 3, vwap: close, close, low: 99, high: close + 1, open: 100,
          learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
          finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed' },
      };
      record.recordId = broadKrakenRecordIdOf(record); now = record.recordedTs;
      assert.equal(archive.tryAcceptRecord(record).accepted, true);
    }
    const req = request(END + MIN);
    const source = createOpportunityAuditBroadDayOutcomeSource({ archiveRoot: root, openBroadDayReader, clock: () => END + MIN + 1 });
    assert.equal((await source(req)).state, 'PENDING', 'active writer has not supplied an immutable view');
    now = END + 520; catalog = catalogAt(now);
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    assert.equal(archive.finalize({ cutoffTs: now }).accepted, true);
    await archive.drain(); await archive.close();
    const result = await source(req);
    assert.equal(result.state, 'AVAILABLE', JSON.stringify(result));
    assert.equal(opportunityAuditBroadDaySourceReceiptError(result.sourceReceipt, { item: req.item }), null);
    assert.equal(result.evidence.bars.length, 60);
    assert.equal(result.evidence.bars[0].close, 113.8);
    assert.equal(result.evidence.bars.at(-1).close, 114.39);
    assert.equal(source.status().republishSafe, false);
    assert.equal(source.status().authority, 'NONE');
  } finally { await archive.close(); rmSync(root, { recursive: true, force: true }); }
});
