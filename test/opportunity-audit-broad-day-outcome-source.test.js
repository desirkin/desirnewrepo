import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { sealAuditFrameV2 } from '../learning/opportunity-audit.js';
import {
  opportunityAuditBroadDaySourceReceiptError, opportunityAuditPendingItemV2,
} from '../learning/opportunity-audit-followup.js';
import {
  createOpportunityAuditBroadDayOutcomeSource,
} from '../learning/opportunity-audit-broad-day-outcome-source.js';
import { canonicalDigest, canonicalJson } from '../learning/contracts.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FRAME_TS = Date.UTC(2026, 8, 13, 23, 30, 0);
const ARCHIVE_ROOT = path.normalize(path.resolve('fixture-broad-day-root'));
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const sha1 = (value) => createHash('sha1').update(String(value)).digest('hex');
const rootDigest = sha256(ARCHIVE_ROOT);

function catalog() {
  const markets = [{
    pairKey: 'XXBTZUSD', nativeBase: 'XXBT', nativeQuote: 'ZUSD', wsname: 'XBT/USD',
    base: 'BTC', quote: 'USD', status: 'online',
  }];
  const body = { venue: 'kraken', quote: 'USD', policyVersion: 1, markets };
  return { ...body, observedTs: FRAME_TS, contentId: sha1(canonicalJson(body)) };
}

function requestOf({ asOfTs = FRAME_TS + HOUR, maxLabelDelayMs = MINUTE } = {}) {
  const frame = sealAuditFrameV2({
    catalog: catalog(), frameTs: FRAME_TS, knownAtTs: FRAME_TS, sampleSize: 1,
    horizonsMs: [HOUR], maxLabelDelayMs, seedHex: '7a'.repeat(32),
  });
  const entry = frame.population[0];
  const item = opportunityAuditPendingItemV2(frame, {
    cursor: 'outcome-1', frameId: frame.frameId, frameDigest: frame.frameDigest,
    opportunityId: entry.opportunityId, canonicalCoin: entry.market.base, horizonMs: HOUR,
    dueTs: frame.frameTs + HOUR, lastOutcomeId: null, lastStatus: null,
    annotationPresent: true, observationInclusionProbability: entry.observationInclusionProbability,
    actionPropensity: entry.actionPropensity,
  });
  return { followupVersion: 'opportunity-audit-followup-2', item, frame: null, annotation: null, asOfTs };
}

function windowOf(item) {
  const anchorOpenTs = Math.ceil(item.frameTs / MINUTE) * MINUTE;
  const terminalOpenTs = Math.floor(item.dueTs / MINUTE) * MINUTE - MINUTE;
  return { anchorOpenTs, terminalOpenTs, terminalCloseTs: terminalOpenTs + MINUTE };
}

function readerMarket(item) {
  return {
    canonicalCoin: item.market.base, pairKey: item.market.pairKey,
    nativeBase: item.market.nativeBase, catalogWsname: item.market.wsname,
  };
}

function cursorOf(datasetDigest, marketIdentityDigest, emittedRows) {
  const body = {
    cursorVersion: 'broad-day-market-cursor-v1', datasetDigest, marketIdentityDigest,
    shardIndex: 1, rowOffset: 0, emittedRows, cursorDigest: '',
  };
  body.cursorDigest = canonicalDigest(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'cursorDigest')));
  return body;
}

function projectedRow({ item, descriptor, readerMarketDigest, periodStartTs, index, catalogContentId }) {
  const close = 100 + index / 10;
  const periodEndTs = periodStartTs + MINUTE;
  const recordDigest = sha256(`record-${periodStartTs}-${close}`);
  return {
    rowVersion: 'broad-day-candle-row-v1', sessionId: 'session-v2', shardFile: 'BTC-2026-09-14.jsonl',
    globalOrdinal: index + 2, globalControlDigest: sha256(`control-${index}`), shardOrdinal: index + 1,
    archiveAdmittedTs: periodEndTs, asOfEligibleTs: periodEndTs,
    recordId: `bkr2-${sha256(`id-${periodStartTs}`)}`, recordDigest, catalogContentId,
    marketIdentityDigest: readerMarketDigest, market: readerMarket(item),
    periodStartTs, periodEndTs, receivedTs: periodEndTs, sourceRecordedTs: periodEndTs,
    open: close, high: close + 1, low: close - 1, close,
    volumeBase: 1, volumeQuote: null, trades: 1, vwap: close,
    finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', conflict: false,
    recordIntegrityVerified: true, conflictFree: true, fullDaySimulationEligible: false,
  };
}

function sealedDescriptor({ item, openArgs, epochEndTs = null, readiness = true }) {
  const market = readerMarket(item); const marketIdentityDigest = canonicalDigest(market);
  const catalogContentId = sha1('catalog-content');
  const epoch = {
    sessionId: 'session-v2', globalOrdinal: 1, controlDigest: sha256('catalog-control'),
    catalogContentId, sourceObservedTs: openArgs.dayStartTs, knownAtTs: openArgs.dayStartTs,
    admittedTs: openArgs.dayStartTs, staleAtAdmission: false,
    marketIdentityDigests: [marketIdentityDigest], kind: 'CATALOG_CONTROL',
    entryVersion: 'broad-day-archive-entry-v2', membershipKnownSinceTs: openArgs.dayStartTs,
    activeUntilTs: epochEndTs ?? openArgs.dayEndTs,
  };
  const core = {
    datasetVersion: 'broad-day-dataset-v1', archiveVersion: 'broad-day-archive-v2',
    dayStartTs: openArgs.dayStartTs, dayEndTs: openArgs.dayEndTs, asOfTs: openArgs.asOfTs,
    sourceProvenance: {
      sourceKind: 'LOCAL_BROAD_DAY_ARCHIVE_V2', sourceRootDigest: rootDigest,
      sessions: [], durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    },
    catalogEpochs: [epoch], catalogUnion: [{ marketIdentityDigest, market }], coverage: [], counters: {},
    completeness: {
      physicalControlAndShardIntegrityVerified: readiness,
      sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite: readiness,
      observedCatalogEpochUnionConstructed: true,
      catalogEpochContinuityVerified: readiness && epoch.activeUntilTs === openArgs.dayEndTs,
      catalogHeartbeatMaxObservedGapMs: 0, catalogHeartbeatRequiredMaximumGapMs: 20 * MINUTE,
      sessionFinalizationVerified: readiness, fullPopulationVerified: readiness,
      fullDaySimulationReady: false, reasons: readiness ? [] : ['FIXTURE_INCOMPLETE'],
    },
    ordering: 'SESSION_ID_THEN_SHARD_FILENAME_THEN_PHYSICAL_SHARD_ORDINAL',
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
  };
  const datasetDigest = canonicalDigest(core);
  return { ...core, datasetDigest, datasetId: `bdd-${datasetDigest}` };
}

function syntheticReaderFactory({
  omitPeriods = [], epochEndTs = null, readiness = true, mutateDescriptor = null,
  mutatePage = null, pause = null,
} = {}) {
  const calls = []; let closes = 0;
  const factory = async (openArgs) => {
    calls.push(structuredClone(openArgs));
    const item = factory.item;
    let descriptor = sealedDescriptor({ item, openArgs, epochEndTs, readiness });
    if (mutateDescriptor) descriptor = mutateDescriptor(structuredClone(descriptor));
    const readerMarketDigest = canonicalDigest(readerMarket(item));
    const target = windowOf(item); const omitted = new Set(omitPeriods);
    const periods = [];
    for (let ts = target.anchorOpenTs; ts <= target.terminalOpenTs; ts += MINUTE) if (!omitted.has(ts)) periods.push(ts);
    let rows = periods.map((periodStartTs, index) => projectedRow({
      item, descriptor, readerMarketDigest, periodStartTs, index,
      catalogContentId: descriptor.catalogEpochs[0].catalogContentId,
    }));
    const nextCursor = cursorOf(descriptor.datasetDigest, readerMarketDigest, rows.length);
    let body = {
      pageVersion: 'broad-day-market-page-v1', datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, marketIdentityDigest: readerMarketDigest,
      cursor: null, nextCursor, done: true, rows,
      rowBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(canonicalJson(row), 'utf8') + 1, 0),
      rowCount: rows.length, authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    let page = { ...body, pageDigest: canonicalDigest(body) };
    if (mutatePage) page = mutatePage(structuredClone(page));
    return {
      version: 'broad-day-reader-v1', descriptor,
      async readMarketPage() { if (pause) await pause; return page; },
      close() { closes += 1; },
    };
  };
  factory.calls = calls; factory.closes = () => closes;
  return factory;
}

function sourceWith(factory, request, clockValue = request.asOfTs + 7) {
  factory.item = request.item;
  return createOpportunityAuditBroadDayOutcomeSource({
    archiveRoot: ARCHIVE_ROOT, openBroadDayReader: factory, clock: () => clockValue,
  });
}

test('cross-UTC exact window becomes AVAILABLE only from a complete source-bound closed-minute inventory', async () => {
  const request = requestOf(); const factory = syntheticReaderFactory();
  const source = sourceWith(factory, request); const result = await source(request);
  assert.equal(result.state, 'AVAILABLE');
  assert.equal(result.preparedTs, request.asOfTs + 7);
  assert.equal(result.evidence.bars.length, 60);
  assert.equal(result.evidence.bars[0].openTs, FRAME_TS);
  assert.equal(result.evidence.bars.at(-1).openTs, FRAME_TS + HOUR - MINUTE);
  assert.equal(result.sourceReceipt.archiveManifest.readerDatasets.length, 1);
  assert.equal(result.sourceReceipt.archiveManifest.readerDatasets[0].sourceMarketIdentityDigest, request.item.marketIdentityDigest);
  assert.equal(opportunityAuditBroadDaySourceReceiptError(result.sourceReceipt, {
    item: request.item, asOfTs: request.asOfTs, evidence: result.evidence,
  }), null);
  assert.equal(factory.calls.length, 1);
  assert.deepEqual(factory.calls[0], {
    rootDir: ARCHIVE_ROOT, dayStartTs: FRAME_TS - 23 * HOUR,
    dayEndTs: FRAME_TS + HOUR, asOfTs: request.asOfTs, signal: null,
  });
  assert.equal(factory.closes(), 1);
  assert.equal(source.status().available, 1);
  assert.equal(source.status().authority, 'NONE');
  assert.equal(source.status().trainingAuthority, 'NONE');
});

test('missing target evidence stays PENDING through the sealed deadline and becomes receipt-bound MISSING only after it', async () => {
  const at = requestOf({ asOfTs: FRAME_TS + HOUR + MINUTE });
  const omitted = [windowOf(at.item).terminalOpenTs];
  let factory = syntheticReaderFactory({ omitPeriods: omitted }); let source = sourceWith(factory, at);
  let result = await source(at);
  assert.deepEqual(result, {
    state: 'PENDING', reasonCode: 'TARGET_CANDLE_WINDOW_INCOMPLETE',
    preparedTs: at.asOfTs + 7, sourceReceipt: null, evidence: null,
  });

  const after = requestOf({ asOfTs: at.item.deadlineTs + 1 });
  factory = syntheticReaderFactory({ omitPeriods: [windowOf(after.item).terminalOpenTs] });
  source = sourceWith(factory, after); result = await source(after);
  assert.equal(result.state, 'MISSING');
  assert.equal(result.evidence, null);
  assert.equal(result.sourceReceipt.recordCount, 59);
  assert.equal(opportunityAuditBroadDaySourceReceiptError(result.sourceReceipt, {
    item: after.item, asOfTs: after.asOfTs, evidence: null,
  }), null);
});

test('ended catalog membership is explicit after deadline and cannot fabricate a complete window', async () => {
  const request = requestOf({ asOfTs: FRAME_TS + HOUR + MINUTE + 1 });
  const terminal = windowOf(request.item).terminalOpenTs;
  const factory = syntheticReaderFactory({ epochEndTs: terminal, omitPeriods: [terminal] });
  const result = await sourceWith(factory, request)(request);
  assert.equal(result.state, 'DELISTED_OR_UNAVAILABLE');
  assert.equal(result.reasonCode, 'CATALOG_MEMBERSHIP_ENDED_BEFORE_TARGET_WINDOW_COMPLETE');
  assert.equal(result.sourceReceipt.resolutionState, 'DELISTED_OR_UNAVAILABLE');
  assert.equal(result.evidence, null);
});

test('an active/unfinalized local archive is PENDING before the deadline and source-bound MISSING only afterwards', async () => {
  const error = Object.assign(new Error('busy'), { code: 'READER_WRITER_ACTIVE' });
  const blocked = async () => { throw error; };
  const at = requestOf({ asOfTs: FRAME_TS + HOUR + MINUTE });
  let result = await createOpportunityAuditBroadDayOutcomeSource({
    archiveRoot: ARCHIVE_ROOT, openBroadDayReader: blocked, clock: () => at.asOfTs,
  })(at);
  assert.equal(result.state, 'PENDING'); assert.equal(result.sourceReceipt, null);
  const after = requestOf({ asOfTs: at.item.deadlineTs + 1 });
  result = await createOpportunityAuditBroadDayOutcomeSource({
    archiveRoot: ARCHIVE_ROOT, openBroadDayReader: blocked, clock: () => after.asOfTs,
  })(after);
  assert.equal(result.state, 'MISSING'); assert.equal(result.sourceReceipt.archiveManifest, null);
  assert.equal(result.sourceReceipt.recordCount, 0);
});

test('late polls use the reader maximum finalized cutoff without backdating the receipt poll', async () => {
  const request = requestOf({ asOfTs: FRAME_TS + HOUR + 4 * 24 * HOUR, maxLabelDelayMs: 3 * 24 * HOUR });
  const factory = syntheticReaderFactory(); const result = await sourceWith(factory, request)(request);
  assert.equal(result.state, 'AVAILABLE');
  assert.equal(factory.calls[0].asOfTs, factory.calls[0].dayEndTs + 48 * HOUR);
  assert.equal(result.sourceReceipt.asOfTs, request.asOfTs);
  assert.equal(result.sourceReceipt.archiveManifest.readerDatasets[0].asOfTs, factory.calls[0].asOfTs);
});

test('tampered reader identities, future rows, false byte accounting and missing cursors are REFUSED, never MISSING', async () => {
  const request = requestOf({ asOfTs: FRAME_TS + HOUR + MINUTE + 1 });
  const cases = [
    syntheticReaderFactory({ mutateDescriptor: (value) => ({ ...value, datasetId: `bdd-${sha256('forged')}` }) }),
    syntheticReaderFactory({ mutatePage: (page) => {
      page.rows[0].asOfEligibleTs = request.asOfTs + 1;
      const body = structuredClone(page); delete body.pageDigest; page.pageDigest = canonicalDigest(body); return page;
    } }),
    syntheticReaderFactory({ mutatePage: (page) => {
      page.rowBytes -= 1; const body = structuredClone(page); delete body.pageDigest; page.pageDigest = canonicalDigest(body); return page;
    } }),
    syntheticReaderFactory({ mutatePage: (page) => {
      page.rows[1].recordId = page.rows[0].recordId; page.rows[1].recordDigest = page.rows[0].recordDigest;
      page.rowBytes = page.rows.reduce((sum, row) => sum + Buffer.byteLength(canonicalJson(row), 'utf8') + 1, 0);
      const body = structuredClone(page); delete body.pageDigest; page.pageDigest = canonicalDigest(body); return page;
    } }),
    syntheticReaderFactory({ mutatePage: (page) => {
      page.done = false; page.nextCursor = null; const body = structuredClone(page); delete body.pageDigest; page.pageDigest = canonicalDigest(body); return page;
    } }),
  ];
  for (const factory of cases) {
    const result = await sourceWith(factory, request)(request);
    assert.equal(result.state, 'REFUSED'); assert.equal(result.sourceReceipt, null);
  }
});

test('busy reads refuse a second call without overlapping reader ownership and requests remain closed-schema', async () => {
  const request = requestOf(); let release; const pause = new Promise((resolve) => { release = resolve; });
  const factory = syntheticReaderFactory({ pause }); const source = sourceWith(factory, request);
  const first = source(request); await new Promise((resolve) => setImmediate(resolve));
  const busy = await source(request); assert.equal(busy.state, 'REFUSED');
  assert.equal(busy.reasonCode, 'LOCAL_ARCHIVE_SOURCE_BUSY'); assert.equal(factory.calls.length, 1);
  release(); assert.equal((await first).state, 'AVAILABLE');
  await assert.rejects(source({ ...request, surprise: true }), /REQUEST_INVALID/);
  const unrelatedFrame = sealAuditFrameV2({
    catalog: catalog(), frameTs: FRAME_TS, knownAtTs: FRAME_TS, sampleSize: 1,
    horizonsMs: [HOUR], maxLabelDelayMs: 2 * MINUTE, seedHex: '7b'.repeat(32),
  });
  await assert.rejects(source({ ...request, frame: unrelatedFrame }), /provided frame does not bind/);
});
