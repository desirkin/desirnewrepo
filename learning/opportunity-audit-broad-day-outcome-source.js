// Bounded LOCAL_FILESYSTEM_ONLY source adapter for V2 opportunity-audit
// follow-up. The market archive reader is injected by the owner so learning
// code does not import a live collector/storage implementation. This adapter
// cannot grant learning, policy, or trading authority.
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS,
  OPPORTUNITY_AUDIT_FOLLOWUP_VERSION_V2,
  opportunityAuditPendingItemV2Error,
  sealOpportunityAuditBroadDayManifest,
  sealOpportunityAuditBroadDaySourceReceipt,
  sealOpportunityAuditCandleEvidence,
} from './opportunity-audit-followup.js';
import {
  canonicalDigest, canonicalJson, deepFreeze, exactKeys, isPlainObject, isTs,
} from './contracts.js';
import { auditAnnotationError, auditFrameError } from './opportunity-audit.js';

export const OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_VERSION = 'opportunity-audit-broad-day-outcome-source-1';
export const OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_DEFAULTS = Object.freeze({
  pageRows: 256,
  maxPages: 8,
  maxRows: OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS,
  maxPageBytes: 8 * 1024 * 1024,
  maxAggregateBytes: 16 * 1024 * 1024,
  maxDescriptorBytes: 16 * 1024 * 1024,
  maxCatalogEpochs: 10_000,
  maxCatalogMarkets: 5_000,
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// broad-day-reader-v1 intentionally refuses snapshots acquired more than 48h
// after the bounded window. Later follow-up polls replay the latest reader
// cutoff it can prove; the outcome receipt still binds the actual poll asOfTs.
const READER_MAX_FINALIZATION_LAG_MS = 48 * 60 * MINUTE_MS;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const REQUEST_KEYS = Object.freeze(['followupVersion', 'item', 'frame', 'annotation', 'asOfTs']);
const DESCRIPTOR_KEYS = Object.freeze([
  'datasetVersion', 'archiveVersion', 'dayStartTs', 'dayEndTs', 'asOfTs', 'sourceProvenance',
  'catalogEpochs', 'catalogUnion', 'coverage', 'counters', 'completeness', 'ordering',
  'authority', 'learningEligible', 'simulationCredit', 'datasetDigest', 'datasetId',
]);
const PAGE_KEYS = Object.freeze([
  'pageVersion', 'datasetId', 'datasetDigest', 'marketIdentityDigest', 'cursor', 'nextCursor',
  'done', 'rows', 'rowBytes', 'rowCount', 'authority', 'learningEligible', 'simulationCredit',
  'pageDigest',
]);
const ROW_KEYS = Object.freeze([
  'rowVersion', 'sessionId', 'shardFile', 'globalOrdinal', 'globalControlDigest', 'shardOrdinal',
  'archiveAdmittedTs', 'asOfEligibleTs', 'recordId', 'recordDigest', 'catalogContentId',
  'marketIdentityDigest', 'market', 'periodStartTs', 'periodEndTs', 'receivedTs',
  'sourceRecordedTs', 'open', 'high', 'low', 'close', 'volumeBase', 'volumeQuote', 'trades',
  'vwap', 'finality', 'conflict', 'recordIntegrityVerified', 'conflictFree',
  'fullDaySimulationEligible',
]);
const ROW_MARKET_KEYS = Object.freeze(['canonicalCoin', 'pairKey', 'nativeBase', 'catalogWsname']);
const EPOCH_KEYS = Object.freeze([
  'sessionId', 'globalOrdinal', 'controlDigest', 'catalogContentId', 'sourceObservedTs',
  'knownAtTs', 'admittedTs', 'staleAtAdmission', 'marketIdentityDigests', 'kind',
  'entryVersion', 'membershipKnownSinceTs', 'activeUntilTs',
]);
const UNION_KEYS = Object.freeze(['marketIdentityDigest', 'market']);
const MARKET_CURSOR_KEYS = Object.freeze([
  'cursorVersion', 'datasetDigest', 'marketIdentityDigest', 'shardIndex',
  'rowOffset', 'emittedRows', 'cursorDigest',
]);
const TRANSIENT_READER_CODES = new Set(['READER_WRITER_ACTIVE', 'READER_SESSIONS_MISSING']);

const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const rootDigest = (value) => createHash('sha256').update(value).digest('hex');

export class OpportunityAuditBroadDaySourceError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit broad-day source: ${code}: ${String(detail).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 300)}`);
    this.name = 'OpportunityAuditBroadDaySourceError';
    this.code = code;
  }
}

const fail = (code, detail) => { throw new OpportunityAuditBroadDaySourceError(code, detail); };

function normalizedLimits(input) {
  if (input === undefined) return OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_DEFAULTS;
  const keys = Object.keys(OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_DEFAULTS);
  if (!exact(input, keys)) fail('CONFIG_INVALID', 'limits must use the exact bounded schema');
  const out = { ...input };
  for (const [key, value] of Object.entries(out)) if (!Number.isSafeInteger(value) || value <= 0) fail('CONFIG_INVALID', `${key} malformed`);
  if (out.pageRows > 5_000 || out.maxPages > 32 || out.maxRows > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS
      || out.maxPageBytes > 32 * 1024 * 1024 || out.maxAggregateBytes > 32 * 1024 * 1024
      || out.maxDescriptorBytes > 64 * 1024 * 1024 || out.maxCatalogEpochs > 10_000
      || out.maxCatalogMarkets > 5_000) fail('CONFIG_INVALID', 'limits exceed hard source bounds');
  return Object.freeze(out);
}

function boundedJsonBytes(value, maximum, code) {
  let text;
  try { text = canonicalJson(value); } catch { fail(code, 'value is not canonical JSON'); }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maximum) fail(code, `canonical bytes ${bytes} exceed ${maximum}`);
  return bytes;
}

function expectedWindow(item) {
  const anchorOpenTs = Math.ceil(item.frameTs / MINUTE_MS) * MINUTE_MS;
  const terminalOpenTs = Math.floor(item.dueTs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  const terminalCloseTs = terminalOpenTs + MINUTE_MS;
  const count = ((terminalOpenTs - anchorOpenTs) / MINUTE_MS) + 1;
  if (!isTs(anchorOpenTs) || !isTs(terminalOpenTs) || !isTs(terminalCloseTs)
      || !Number.isSafeInteger(count) || count < 1 || count > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS) {
    fail('REQUEST_INVALID', 'target window is outside the bounded closed-minute law');
  }
  return Object.freeze({ anchorOpenTs, terminalOpenTs, terminalCloseTs, count });
}

function readerMarketOf(item) {
  return Object.freeze({
    canonicalCoin: item.market.base,
    pairKey: item.market.pairKey,
    nativeBase: item.market.nativeBase,
    catalogWsname: item.market.wsname,
  });
}

function descriptorCore(descriptor) {
  const core = structuredClone(descriptor); delete core.datasetId; delete core.datasetDigest; return core;
}

function descriptorError(descriptor, { dayStartTs, dayEndTs, asOfTs, expectedRootDigest, limits }) {
  if (!exact(descriptor, DESCRIPTOR_KEYS) || descriptor.datasetVersion !== 'broad-day-dataset-v1'
      || descriptor.archiveVersion !== 'broad-day-archive-v2'
      || descriptor.dayStartTs !== dayStartTs || descriptor.dayEndTs !== dayEndTs || descriptor.asOfTs !== asOfTs
      || !/^bdd-[a-f0-9]{64}$/.test(descriptor.datasetId ?? '') || !HEX64.test(descriptor.datasetDigest ?? '')
      || descriptor.datasetId !== `bdd-${descriptor.datasetDigest}` || descriptor.authority !== 'NONE'
      || descriptor.learningEligible !== false || descriptor.simulationCredit !== 0
      || !isPlainObject(descriptor.sourceProvenance)
      || descriptor.sourceProvenance.sourceKind !== 'LOCAL_BROAD_DAY_ARCHIVE_V2'
      || descriptor.sourceProvenance.sourceRootDigest !== expectedRootDigest
      || descriptor.sourceProvenance.durability !== 'LOCAL_FILESYSTEM_ONLY'
      || descriptor.sourceProvenance.republishSafe !== false
      || !Array.isArray(descriptor.catalogEpochs) || descriptor.catalogEpochs.length > limits.maxCatalogEpochs
      || !Array.isArray(descriptor.catalogUnion) || descriptor.catalogUnion.length > limits.maxCatalogMarkets
      || descriptor.catalogUnion.some((row) => !exact(row, UNION_KEYS) || !HEX64.test(row.marketIdentityDigest ?? '')
        || !exact(row.market, ROW_MARKET_KEYS) || canonicalDigest(row.market) !== row.marketIdentityDigest)
      || new Set(descriptor.catalogUnion.map((row) => row.marketIdentityDigest)).size !== descriptor.catalogUnion.length
      || !Array.isArray(descriptor.coverage) || descriptor.coverage.length > limits.maxCatalogMarkets
      || !isPlainObject(descriptor.completeness)) return 'descriptor shape, source or clocks malformed';
  boundedJsonBytes(descriptor, limits.maxDescriptorBytes, 'READER_DESCRIPTOR_INVALID');
  if (canonicalDigest(descriptorCore(descriptor)) !== descriptor.datasetDigest) return 'descriptor digest mismatch';
  return null;
}

function epochError(epoch, descriptor, limits) {
  if (!exact(epoch, EPOCH_KEYS) || !Number.isSafeInteger(epoch.globalOrdinal) || epoch.globalOrdinal <= 0
      || typeof epoch.sessionId !== 'string' || epoch.sessionId.length < 1 || epoch.sessionId.length > 128
      || !HEX64.test(epoch.controlDigest ?? '') || !HEX40.test(epoch.catalogContentId ?? '')
      || !isTs(epoch.sourceObservedTs) || !isTs(epoch.knownAtTs) || !isTs(epoch.admittedTs)
      || epoch.sourceObservedTs > epoch.knownAtTs || epoch.knownAtTs > epoch.admittedTs
      || epoch.admittedTs >= epoch.activeUntilTs || !isTs(epoch.activeUntilTs)
      || epoch.admittedTs >= descriptor.dayEndTs || epoch.activeUntilTs <= descriptor.dayStartTs
      || epoch.activeUntilTs > descriptor.dayEndTs || epoch.staleAtAdmission !== false
      || !['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(epoch.kind)
      || epoch.entryVersion !== 'broad-day-archive-entry-v2'
      || !isTs(epoch.membershipKnownSinceTs) || epoch.membershipKnownSinceTs > epoch.admittedTs
      || !Array.isArray(epoch.marketIdentityDigests) || epoch.marketIdentityDigests.length > limits.maxCatalogMarkets
      || epoch.marketIdentityDigests.some((value) => !HEX64.test(value))
      || new Set(epoch.marketIdentityDigests).size !== epoch.marketIdentityDigests.length
      || [...epoch.marketIdentityDigests].sort().join('|') !== epoch.marketIdentityDigests.join('|')) return 'catalog epoch malformed';
  return null;
}

function cursorError(cursor, { datasetDigest, readerMarketDigest }) {
  if (cursor === null) return null;
  if (!exact(cursor, MARKET_CURSOR_KEYS) || cursor.cursorVersion !== 'broad-day-market-cursor-v1'
      || cursor.datasetDigest !== datasetDigest || cursor.marketIdentityDigest !== readerMarketDigest
      || !Number.isSafeInteger(cursor.shardIndex) || cursor.shardIndex < 0
      || !Number.isSafeInteger(cursor.rowOffset) || cursor.rowOffset < 0
      || !Number.isSafeInteger(cursor.emittedRows) || cursor.emittedRows < 0
      || !HEX64.test(cursor.cursorDigest ?? '')) return 'market cursor shape or identity malformed';
  const body = structuredClone(cursor); delete body.cursorDigest;
  return canonicalDigest(body) === cursor.cursorDigest ? null : 'market cursor digest mismatch';
}

function rowError(row, { readerMarketDigest, readerMarket, descriptor, asOfTs }) {
  if (!exact(row, ROW_KEYS) || row.rowVersion !== 'broad-day-candle-row-v1'
      || typeof row.sessionId !== 'string' || row.sessionId.length < 1 || row.sessionId.length > 128
      || typeof row.shardFile !== 'string' || row.shardFile.length < 1 || row.shardFile.length > 256
      || !Number.isSafeInteger(row.globalOrdinal) || row.globalOrdinal <= 0
      || !Number.isSafeInteger(row.shardOrdinal) || row.shardOrdinal <= 0
      || !HEX64.test(row.globalControlDigest ?? '') || !HEX64.test(row.recordDigest ?? '')
      || !/^bkr2-[a-f0-9]{64}$/.test(row.recordId ?? '')
      || !HEX40.test(row.catalogContentId ?? '')
      || row.marketIdentityDigest !== readerMarketDigest || !exact(row.market, ROW_MARKET_KEYS)
      || !same(row.market, readerMarket) || !isTs(row.archiveAdmittedTs) || !isTs(row.asOfEligibleTs)
      || !isTs(row.receivedTs) || !isTs(row.sourceRecordedTs) || row.receivedTs > row.asOfEligibleTs
      || row.receivedTs > row.sourceRecordedTs || row.sourceRecordedTs > row.archiveAdmittedTs
      || row.archiveAdmittedTs > row.asOfEligibleTs || row.asOfEligibleTs > asOfTs
      || !isTs(row.periodStartTs) || row.periodStartTs % MINUTE_MS !== 0
      || row.periodEndTs !== row.periodStartTs + MINUTE_MS || row.periodEndTs > row.receivedTs
      || row.periodStartTs < descriptor.dayStartTs || row.periodEndTs > descriptor.dayEndTs
      || ![row.open, row.high, row.low, row.close].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.high < row.low
      || typeof row.volumeBase !== 'number' || !Number.isFinite(row.volumeBase) || row.volumeBase < 0
      || row.volumeQuote !== null || !(row.vwap === null || (typeof row.vwap === 'number' && Number.isFinite(row.vwap) && row.vwap > 0))
      || !Number.isSafeInteger(row.trades) || row.trades < 0
      || row.finality !== 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL'
      || row.conflict !== false || row.recordIntegrityVerified !== true || row.conflictFree !== true
      || row.fullDaySimulationEligible !== false) return 'projected candle row malformed, future, conflicting or cross-market';
  return null;
}

function sourceBinding(expectedRootDigest) {
  return deepFreeze({
    bindingVersion: 'broad-day-local-source-binding-1',
    sourceId: 'broad-day-local-archive-v2',
    sourceRootDigest: expectedRootDigest,
    archiveVersion: 'broad-day-archive-v2',
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
  });
}

function transientResolution(item, asOfTs, preparedTs, reasonCode) {
  if (asOfTs <= item.deadlineTs) return deepFreeze({ state: 'PENDING', reasonCode, preparedTs, sourceReceipt: null, evidence: null });
  return null;
}

export function createOpportunityAuditBroadDayOutcomeSource({
  archiveRoot, openBroadDayReader, clock = () => Date.now(), limits: suppliedLimits,
} = {}) {
  if (typeof archiveRoot !== 'string' || archiveRoot.length < 1 || archiveRoot.length > 1_024
      || !path.isAbsolute(archiveRoot) || path.normalize(archiveRoot) !== archiveRoot || archiveRoot.includes('\u0000')
      || typeof openBroadDayReader !== 'function' || typeof clock !== 'function') fail('CONFIG_INVALID', 'fixed absolute archiveRoot, reader factory and clock required');
  const limits = normalizedLimits(suppliedLimits);
  const expectedRootDigest = rootDigest(archiveRoot);
  const binding = sourceBinding(expectedRootDigest);
  let active = false; let calls = 0; let available = 0; let pending = 0; let missing = 0; let refused = 0; let last = null;

  async function outcomeSource(rawRequest) {
    let request;
    try { request = deepFreeze(structuredClone(rawRequest)); } catch { fail('REQUEST_INVALID', 'request cannot be copied'); }
    if (!exact(request, REQUEST_KEYS) || request.followupVersion !== OPPORTUNITY_AUDIT_FOLLOWUP_VERSION_V2
        || opportunityAuditPendingItemV2Error(request.item) || !isTs(request.asOfTs)) fail('REQUEST_INVALID', 'exact V2 follow-up request required');
    if (request.frame !== null && (auditFrameError(request.frame)
        || request.frame.frameId !== request.item.frameId || request.frame.frameDigest !== request.item.frameDigest)) {
      fail('REQUEST_INVALID', 'provided frame does not bind the pending item');
    }
    if (request.annotation !== null && (request.frame === null
        || auditAnnotationError(request.annotation, request.frame)
        || request.annotation.opportunityId !== request.item.opportunityId)) {
      fail('REQUEST_INVALID', 'provided annotation does not bind the pending item');
    }
    const { item, asOfTs } = request; const window = expectedWindow(item);
    if (active) {
      const preparedTs = clock(); if (!isTs(preparedTs) || preparedTs < asOfTs) fail('CLOCK_INVALID', 'prepared clock predates busy refusal');
      calls += 1; refused += 1;
      const resolution = deepFreeze({ state: 'REFUSED', reasonCode: 'LOCAL_ARCHIVE_SOURCE_BUSY', preparedTs, sourceReceipt: null, evidence: null });
      last = resolution; return resolution;
    }
    active = true; calls += 1; const opened = [];
    try {
      if (asOfTs < item.dueTs || asOfTs < window.terminalCloseTs) {
        const preparedTs = clock(); if (!isTs(preparedTs) || preparedTs < asOfTs) fail('CLOCK_INVALID', 'prepared clock predates request');
        const resolution = deepFreeze({ state: 'PENDING', reasonCode: 'TARGET_WINDOW_NOT_CLOSED', preparedTs, sourceReceipt: null, evidence: null });
        pending += 1; last = resolution; return resolution;
      }
      // The actual reader accepts any minute-aligned completed 23-25h window.
      // End the deterministic 24h read at the target's terminal close so a
      // cross-UTC horizon does not wait for the following UTC midnight.
      const dayEndTs = window.terminalCloseTs; const dayStartTs = dayEndTs - DAY_MS;
      const readerAsOfTs = Math.min(asOfTs, dayEndTs + READER_MAX_FINALIZATION_LAG_MS);
      let reader;
      try {
        reader = await openBroadDayReader({ rootDir: archiveRoot, dayStartTs, dayEndTs, asOfTs: readerAsOfTs, signal: null });
      } catch (error) {
        const preparedTs = clock(); if (!isTs(preparedTs) || preparedTs < asOfTs) fail('CLOCK_INVALID', 'prepared clock predates failed read');
        const reasonCode = TRANSIENT_READER_CODES.has(error?.code) ? 'LOCAL_ARCHIVE_WINDOW_NOT_IMMUTABLE' : 'LOCAL_ARCHIVE_READER_REFUSED';
        const transient = TRANSIENT_READER_CODES.has(error?.code) ? transientResolution(item, asOfTs, preparedTs, reasonCode) : null;
        if (transient) { pending += 1; last = transient; return transient; }
        if (!TRANSIENT_READER_CODES.has(error?.code)) {
          const resolution = deepFreeze({ state: 'REFUSED', reasonCode, preparedTs, sourceReceipt: null, evidence: null });
          refused += 1; last = resolution; return resolution;
        }
        const receipt = sealOpportunityAuditBroadDaySourceReceipt({ item, asOfTs, preparedTs,
          resolutionState: 'MISSING', resolutionReason: 'LOCAL_ARCHIVE_WINDOW_UNAVAILABLE_AFTER_DEADLINE',
          sourceBinding: binding, archiveManifest: null, records: [], evidence: null });
        const resolution = deepFreeze({ state: 'MISSING', reasonCode: receipt.resolutionReason, preparedTs, sourceReceipt: receipt, evidence: null });
        missing += 1; last = resolution; return resolution;
      }
      opened.push(reader);
      if (!reader || reader.version !== 'broad-day-reader-v1' || typeof reader.readMarketPage !== 'function' || typeof reader.close !== 'function') fail('READER_INTERFACE_INVALID', 'reader port malformed');
      const descriptor = reader.descriptor;
      const descriptorProblem = descriptorError(descriptor, { dayStartTs, dayEndTs, asOfTs: readerAsOfTs, expectedRootDigest, limits });
      if (descriptorProblem) fail('READER_DESCRIPTOR_INVALID', descriptorProblem);
      for (const epoch of descriptor.catalogEpochs) {
        const problem = epochError(epoch, descriptor, limits); if (problem) fail('READER_DESCRIPTOR_INVALID', problem);
      }
      if (descriptor.completeness.catalogEpochContinuityVerified === true) {
        if (!descriptor.catalogEpochs.length || descriptor.catalogEpochs[0].admittedTs > descriptor.dayStartTs
            || descriptor.catalogEpochs.at(-1).activeUntilTs !== descriptor.dayEndTs
            || descriptor.catalogEpochs.slice(1).some((epoch, index) => descriptor.catalogEpochs[index].activeUntilTs !== epoch.admittedTs)) {
          fail('READER_DESCRIPTOR_INVALID', 'claimed catalog continuity lacks exact boundary/adjacency proof');
        }
      }
      const readerMarket = readerMarketOf(item); const readerMarketDigest = canonicalDigest(readerMarket);
      const unionRows = descriptor.catalogUnion.filter((row) => row?.marketIdentityDigest === readerMarketDigest);
      if (unionRows.length > 1 || (unionRows.length === 1 && !same(unionRows[0].market, readerMarket))) fail('READER_DESCRIPTOR_INVALID', 'catalog union market mapping is ambiguous');
      let cursor = null; let pages = 0; let aggregateBytes = 0; const rows = [];
      if (unionRows.length === 1) {
        while (true) {
          pages += 1; if (pages > limits.maxPages) fail('SOURCE_BOUND_EXCEEDED', 'market page count exceeds bound');
          const page = await reader.readMarketPage({ marketIdentityDigest: readerMarketDigest, cursor, maxRows: limits.pageRows, signal: null });
          if (!exact(page, PAGE_KEYS) || page.pageVersion !== 'broad-day-market-page-v1'
              || page.datasetId !== descriptor.datasetId || page.datasetDigest !== descriptor.datasetDigest
              || page.marketIdentityDigest !== readerMarketDigest
              || typeof page.done !== 'boolean' || !Array.isArray(page.rows) || page.rowCount !== page.rows.length
              || !Number.isSafeInteger(page.rowBytes) || page.rowBytes < 0 || page.rowBytes > limits.maxPageBytes
              || page.authority !== 'NONE' || page.learningEligible !== false || page.simulationCredit !== 0
              || !HEX64.test(page.pageDigest ?? '')) fail('READER_PAGE_INVALID', 'page envelope or source identity malformed');
          const currentCursorProblem = cursorError(page.cursor, { datasetDigest: descriptor.datasetDigest, readerMarketDigest });
          const nextCursorProblem = cursorError(page.nextCursor, { datasetDigest: descriptor.datasetDigest, readerMarketDigest });
          const cursorMatches = currentCursorProblem === null && same(page.cursor, cursor);
          if (currentCursorProblem || nextCursorProblem || page.nextCursor === null || !cursorMatches) {
            fail('READER_PAGE_INVALID', currentCursorProblem ?? nextCursorProblem
              ?? (page.nextCursor === null ? 'next cursor missing' : 'page cursor does not match request'));
          }
          let expectedRowBytes = 0;
          for (const row of page.rows) {
            const problem = rowError(row, { readerMarketDigest, readerMarket, descriptor, asOfTs: readerAsOfTs });
            if (problem) fail('READER_ROW_INVALID', problem);
            expectedRowBytes += Buffer.byteLength(canonicalJson(row), 'utf8') + 1;
            if (expectedRowBytes > limits.maxPageBytes) fail('SOURCE_BOUND_EXCEEDED', 'physical page rows exceed bound');
          }
          if (page.rowBytes !== expectedRowBytes) fail('READER_PAGE_INVALID', 'page physical row-byte accounting mismatch');
          const body = structuredClone(page); delete body.pageDigest;
          boundedJsonBytes(body, limits.maxPageBytes + 512 * 1024, 'READER_PAGE_INVALID');
          if (canonicalDigest(body) !== page.pageDigest) fail('READER_PAGE_INVALID', 'page digest mismatch');
          aggregateBytes += page.rowBytes; if (aggregateBytes > limits.maxAggregateBytes) fail('SOURCE_BOUND_EXCEEDED', 'aggregate page bytes exceed bound');
          for (const row of page.rows) {
            rows.push(row); if (rows.length > limits.maxRows) fail('SOURCE_BOUND_EXCEEDED', 'aggregate market rows exceed bound');
          }
          if (page.done) break;
          if (page.nextCursor === null || same(page.nextCursor, cursor)) fail('READER_PAGE_INVALID', 'unfinished page cursor did not advance');
          cursor = page.nextCursor;
        }
      }
      if (new Set(rows.map((row) => row.recordId)).size !== rows.length
          || new Set(rows.map((row) => row.recordDigest)).size !== rows.length) {
        fail('READER_ROW_INVALID', 'projected record identity is duplicated');
      }
      const byPeriod = new Map();
      for (const row of rows) {
        if (row.periodStartTs < window.anchorOpenTs || row.periodStartTs > window.terminalOpenTs) continue;
        if (byPeriod.has(row.periodStartTs)) fail('READER_ROW_INVALID', 'target minute is duplicated');
        byPeriod.set(row.periodStartTs, row);
      }
      const targetPeriods = Array.from({ length: window.count }, (_, index) => window.anchorOpenTs + index * MINUTE_MS);
      const membershipEpochs = []; let missingMembership = 0; let membershipEnded = false;
      for (const periodStartTs of targetPeriods) {
        const matching = descriptor.catalogEpochs.filter((epoch) => epoch.admittedTs <= periodStartTs
          && epoch.activeUntilTs > periodStartTs && epoch.marketIdentityDigests.includes(readerMarketDigest));
        if (matching.length > 1) fail('READER_DESCRIPTOR_INVALID', 'overlapping catalog membership epochs');
        if (matching.length === 0) { missingMembership += 1; membershipEnded ||= membershipEpochs.length > 0; }
        else membershipEpochs.push(matching[0]);
        const row = byPeriod.get(periodStartTs);
        if (row && (matching.length !== 1 || row.catalogContentId !== matching[0].catalogContentId)) fail('READER_ROW_INVALID', 'candle disagrees with as-of catalog membership');
      }
      const records = targetPeriods.flatMap((periodStartTs) => {
        const row = byPeriod.get(periodStartTs); return row ? [{
          recordId: row.recordId, recordDigest: row.recordDigest,
          periodStartTs: row.periodStartTs, periodEndTs: row.periodEndTs,
          knownAtTs: row.asOfEligibleTs, close: row.close,
        }] : [];
      });
      const readiness = descriptor.completeness.physicalControlAndShardIntegrityVerified === true
        && descriptor.completeness.sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite === true
        && descriptor.completeness.catalogEpochContinuityVerified === true
        && descriptor.completeness.sessionFinalizationVerified === true
        && descriptor.completeness.fullPopulationVerified === true;
      const dataset = {
        datasetVersion: descriptor.datasetVersion, datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
        dayStartTs: descriptor.dayStartTs, dayEndTs: descriptor.dayEndTs, asOfTs: descriptor.asOfTs,
        sourceRootDigest: expectedRootDigest, catalogEpochDigest: canonicalDigest(descriptor.catalogEpochs),
        sourceMarketIdentityDigest: item.marketIdentityDigest,
      };
      const membershipProof = [...new Map(membershipEpochs.map((epoch) => [epoch.controlDigest, {
        datasetDigest: descriptor.datasetDigest, readerMarketIdentityDigest: readerMarketDigest,
        controlDigest: epoch.controlDigest, catalogContentId: epoch.catalogContentId,
        admittedTs: epoch.admittedTs, activeUntilTs: epoch.activeUntilTs,
        knownAtTs: epoch.knownAtTs, sourceObservedTs: epoch.sourceObservedTs,
      }])).values()];
      const manifest = sealOpportunityAuditBroadDayManifest({ item, sourceBinding: binding,
        readerDatasets: [dataset], catalogMembershipDigest: canonicalDigest(membershipProof), records });
      const complete = readiness && missingMembership === 0 && records.length === window.count;
      const preparedTs = clock(); if (!isTs(preparedTs) || preparedTs < asOfTs) fail('CLOCK_INVALID', 'prepared clock predates completed reads');
      if (!complete && asOfTs <= item.deadlineTs) {
        const resolution = deepFreeze({ state: 'PENDING', reasonCode: readiness ? 'TARGET_CANDLE_WINDOW_INCOMPLETE' : 'LOCAL_ARCHIVE_CUSTODY_NOT_FINALIZED', preparedTs, sourceReceipt: null, evidence: null });
        pending += 1; last = resolution; return resolution;
      }
      if (complete) {
        const evidence = sealOpportunityAuditCandleEvidence({
          canonicalCoin: item.market.base, sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: binding.sourceId,
          archiveDigest: manifest.manifestDigest, archiveCreatedTs: asOfTs,
          bars: records.map((row) => ({ openTs: row.periodStartTs, close: row.close, knownAtTs: row.knownAtTs })),
        });
        const receipt = sealOpportunityAuditBroadDaySourceReceipt({ item, asOfTs, preparedTs,
          resolutionState: 'AVAILABLE', resolutionReason: null, sourceBinding: binding,
          archiveManifest: manifest, records, evidence });
        const resolution = deepFreeze({ state: 'AVAILABLE', reasonCode: null, preparedTs, sourceReceipt: receipt, evidence });
        available += 1; last = resolution; return resolution;
      }
      const resolutionState = missingMembership > 0 && membershipEnded ? 'DELISTED_OR_UNAVAILABLE' : 'MISSING';
      const resolutionReason = resolutionState === 'DELISTED_OR_UNAVAILABLE'
        ? 'CATALOG_MEMBERSHIP_ENDED_BEFORE_TARGET_WINDOW_COMPLETE'
        : 'LOCAL_ARCHIVE_TARGET_WINDOW_INCOMPLETE_AFTER_DEADLINE';
      const receipt = sealOpportunityAuditBroadDaySourceReceipt({ item, asOfTs, preparedTs,
        resolutionState, resolutionReason, sourceBinding: binding, archiveManifest: manifest, records, evidence: null });
      const resolution = deepFreeze({ state: resolutionState, reasonCode: resolutionReason, preparedTs, sourceReceipt: receipt, evidence: null });
      missing += 1; last = resolution; return resolution;
    } catch (error) {
      if (error instanceof OpportunityAuditBroadDaySourceError && ['REQUEST_INVALID', 'CLOCK_INVALID'].includes(error.code)) throw error;
      const preparedTs = clock(); if (!isTs(preparedTs) || preparedTs < asOfTs) throw error;
      const resolution = deepFreeze({ state: 'REFUSED', reasonCode: error?.code === 'SOURCE_BOUND_EXCEEDED' ? 'LOCAL_ARCHIVE_SOURCE_BOUND_EXCEEDED' : 'LOCAL_ARCHIVE_INTEGRITY_REFUSED', preparedTs, sourceReceipt: null, evidence: null });
      refused += 1; last = resolution; return resolution;
    } finally {
      for (const reader of opened.reverse()) { try { reader.close(); } catch { /* source result remains conservative */ } }
      active = false;
    }
  }

  const status = () => deepFreeze({
    version: OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_VERSION,
    state: active ? 'READING' : 'READY', calls, available, pending, missing, refused,
    last: last === null ? null : { state: last.state, reasonCode: last.reasonCode, preparedTs: last.preparedTs },
    sourceBinding: binding, limits, authority: 'NONE', trainingAuthority: 'NONE',
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
  });
  return Object.freeze(Object.assign(outcomeSource, { version: OPPORTUNITY_AUDIT_BROAD_DAY_OUTCOME_SOURCE_VERSION, status }));
}
