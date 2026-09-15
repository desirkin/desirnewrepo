import path from 'node:path';
import {
  createReadStream, existsSync, lstatSync, readdirSync, realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BROAD_KRAKEN_RECORD_VERSION,
  BROAD_KRAKEN_RECORD_VERSION_V2,
  broadKrakenRecordIdOf,
  validateBroadKrakenCatalog,
} from './broad-kraken.js';
import {
  BROAD_DAY_ARCHIVE_ENTRY_VERSION,
  BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2,
  BROAD_DAY_ARCHIVE_VERSION,
  BROAD_DAY_ARCHIVE_VERSION_V2,
} from './broad-day-archive.js';
import {
  BROAD_DAY_DATASET_VERSION,
  BROAD_DAY_CURSOR_VERSION,
  BROAD_DAY_PAGE_VERSION,
  BROAD_DAY_MARKET_CURSOR_VERSION,
  BROAD_DAY_MARKET_PAGE_VERSION,
  BROAD_DAY_READER_DEFAULTS,
  CEILINGS,
  MINUTE,
  HEX64,
  SESSION_RE,
  SHARD_RE,
  CONTROL_COMMON,
  CATALOG_CONTROL_KEYS,
  CATALOG_CONTROL_V2_KEYS,
  SOURCE_CONTROL_KEYS,
  CANDLE_INDEX_KEYS,
  SHARD_KEYS,
  FINALIZATION_KEYS,
  CLOSED_PAYLOAD_KEYS,
  BROAD_RECORD_KEYS,
  BROAD_MARKET_KEYS,
  positive,
  count,
  plain,
  sha256,
  clone,
  freeze,
  BroadDayReaderError,
  fail,
  exactKeys,
  canonicalBounded,
  limitsOf,
  realDirectory,
  fileInfo,
  signalError,
  throwIfCancelled,
  scanJsonl,
  utcDate,
  marketIdentity,
  marketDigest,
  archiveMarketDigest,
  digestWithout,
  chainDigest,
  commonControlError,
  catalogControlError,
  commonRecordError,
  recordMembershipError,
  closedRecordError,
  sourceControlError,
  expectedShardSummary,
  actualShardSummary,
  coverageState,
  publicCoverage,
  cursorError,
  marketCursorError,
  pageRow,
} from './broad-day-reader-core.js';

export async function openBroadDayReader({
  rootDir, dayStartTs, dayEndTs, asOfTs, limits: suppliedLimits, signal = null,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir.length < 1) fail('READER_ROOT_INVALID', 'rootDir required');
  const abortError = signalError(signal); if (abortError) fail('READER_ARGUMENT_INVALID', abortError);
  throwIfCancelled(signal);
  const limits = limitsOf(suppliedLimits);
  if (!positive(dayStartTs) || !positive(dayEndTs) || dayEndTs <= dayStartTs
      || dayEndTs - dayStartTs < 23 * 60 * MINUTE || dayEndTs - dayStartTs > 25 * 60 * MINUTE
      || dayStartTs % MINUTE !== 0 || dayEndTs % MINUTE !== 0
      || (dayEndTs - dayStartTs) % MINUTE !== 0 || !positive(asOfTs) || asOfTs < dayEndTs
      || asOfTs - dayEndTs > limits.maxFinalizationLagMs) fail('READER_CLOCK_INVALID', 'completed-day/asOf clocks violate bounds');
  const archiveRoot = realDirectory(path.resolve(rootDir), 'READER_ROOT_INVALID');
  if (existsSync(path.join(archiveRoot, 'writer.lock'))) fail('READER_WRITER_ACTIVE', 'archive writer.lock is present; immutable snapshot unavailable');
  const sessionsRoot = realDirectory(path.join(archiveRoot, 'sessions'), 'READER_SESSIONS_MISSING');
  const initialNames = readdirSync(sessionsRoot).sort();
  if (initialNames.length < 1 || initialNames.length > limits.maxSessions || initialNames.some((name) => !SESSION_RE.test(name))) fail('READER_SESSION_INVENTORY_INVALID', 'session inventory empty, malformed, or over bound');

  const dayMinutes = (dayEndTs - dayStartTs) / MINUTE;
  const sessionMetas = []; const catalogObservations = []; const identities = new Map(); const eligibleIdentities = new Set(); const coverage = new Map();
  let totalBytes = 0; let totalControlRows = 0; let catalogControlCount = 0;
  let catalogHeartbeatCount = 0; let sessionFinalizationCount = 0;
  let sourceControlCount = 0; let candleIndexCount = 0; let candleRowCount = 0; let canonicalV2CandleRows = 0;
  let relevantRows = 0; let asOfEligibleRows = 0; let futureWithheldRows = 0; let staleCatalogControls = 0;
  let futureCatalogControlsWithheld = 0; let totalShardFiles = 0; let duplicateCandleRows = 0; let catalogAsOfWithheldRows = 0;
  const seenRecordDigests = new Map(); const eligibleCandleLocations = new Set();

  for (const sessionId of initialNames) {
    const sessionDir = realDirectory(path.join(sessionsRoot, sessionId), 'READER_SESSION_INVALID');
    const sessionEntries = readdirSync(sessionDir).sort();
    if (sessionEntries.some((name) => !['controls.jsonl', 'shards'].includes(name))) fail('READER_SESSION_INVENTORY_INVALID', 'session contains an undeclared file', { sessionId });
    const shardsDir = realDirectory(path.join(sessionDir, 'shards'), 'READER_SHARDS_MISSING');
    const shardNames = readdirSync(shardsDir).sort();
    totalShardFiles += shardNames.length;
    if (totalShardFiles > limits.maxShardFiles || shardNames.some((name) => !SHARD_RE.test(name))) fail('READER_SHARD_INVENTORY_INVALID', 'aggregate shard inventory malformed or over bound', { sessionId });
    const controlFile = path.join(sessionDir, 'controls.jsonl');
    if (!existsSync(controlFile)) {
      if (shardNames.length) fail('READER_CONTROL_MISSING', 'session has shards without a control ledger', { sessionId });
      sessionMetas.push({
        sessionId, controls: null, shards: [], empty: true, sourceDigest: sha256(`EMPTY:${sessionId}`),
        entryVersion: null, archiveVersion: null, startedTs: Number(SESSION_RE.exec(sessionId)?.[1]),
        firstCatalogAdmittedTs: null, finalized: null,
      });
      continue;
    }

    const catalogs = new Map(); const expectedShards = new Map();
    let lastDigest = null; let nextOrdinal = 1; let lastAdmittedTs = 0;
    let sessionEntryVersion = null; let lastCatalog = null; let finalized = null; let finalizationLineBytes = 0;
    const sessionCounts = { catalogControls: 0, catalogHeartbeats: 0, sourceControls: 0, closedCandles: 0 };
    const controls = await scanJsonl(controlFile, {
      maxFileBytes: limits.maxControlFileBytes,
      maxLineBytes: limits.maxCatalogLineBytes,
      maxRows: limits.maxControlRows,
      signal,
      onRow: async (row, rowMeta) => {
        totalControlRows += 1; if (totalControlRows > limits.maxControlRows) fail('READER_ROW_LIMIT', 'aggregate control rows exceed bound');
        if (sessionEntryVersion === null) {
          if (![BROAD_DAY_ARCHIVE_ENTRY_VERSION, BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2].includes(row?.entryVersion)) fail('READER_CONTROL_INVALID', 'unsupported session entry version', { sessionId, ordinal: nextOrdinal });
          sessionEntryVersion = row.entryVersion;
        }
        let keys;
        if (['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(row?.kind)) keys = exactKeys(row, sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 ? CATALOG_CONTROL_V2_KEYS : CATALOG_CONTROL_KEYS);
        else if (row?.kind === 'SOURCE_CONTROL') keys = exactKeys(row, SOURCE_CONTROL_KEYS);
        else if (row?.kind === 'CLOSED_CANDLE_INDEX') keys = exactKeys(row, CANDLE_INDEX_KEYS);
        else if (row?.kind === 'SESSION_FINALIZATION') keys = exactKeys(row, FINALIZATION_KEYS);
        else fail('READER_CONTROL_INVALID', 'unsupported control kind', { sessionId, ordinal: nextOrdinal });
        if (keys) fail('READER_CONTROL_INVALID', keys, { sessionId, ordinal: nextOrdinal });
        if (finalized) fail('READER_FINALIZATION_INVALID', 'control appears after session finalization', { sessionId, ordinal: nextOrdinal });
        const common = commonControlError(row, lastDigest, nextOrdinal, sessionEntryVersion);
        if (common || row.admittedTs < lastAdmittedTs) fail('READER_CONTROL_INVALID', common ?? 'control admission clock regressed', { sessionId, ordinal: nextOrdinal });
        if (['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(row.kind)) {
          if (row.kind === 'CATALOG_CONTROL') { catalogControlCount += 1; sessionCounts.catalogControls += 1; }
          else { catalogHeartbeatCount += 1; sessionCounts.catalogHeartbeats += 1; }
          if (catalogControlCount + catalogHeartbeatCount > limits.maxCatalogControls) fail('READER_ROW_LIMIT', 'catalog-control count exceeds bound');
          const error = catalogControlError(row, limits, sessionEntryVersion, lastCatalog); if (error) fail('READER_CATALOG_CONTROL_INVALID', error, { sessionId, ordinal: row.globalOrdinal });
          const catalogState = Object.freeze({
            ...row,
            membershipKnownSinceTs: lastCatalog?.contentId === row.contentId
              ? lastCatalog.membershipKnownSinceTs : row.admittedTs,
          });
          catalogs.set(row.controlDigest, catalogState);
          const members = [];
          for (const market of row.catalog.markets) {
            const identity = marketIdentity(market); const digest = marketDigest(identity);
            if (!identities.has(digest)) identities.set(digest, identity);
            if (!coverage.has(digest)) coverage.set(digest, coverageState(identity, dayMinutes));
            members.push(digest);
          }
          catalogObservations.push({
            sessionId, globalOrdinal: row.globalOrdinal, controlDigest: row.controlDigest,
            catalogContentId: row.contentId, sourceObservedTs: row.sourceObservedTs,
            knownAtTs: row.knownAtTs, admittedTs: row.admittedTs,
            staleAtAdmission: row.knownAtTs - row.sourceObservedTs > limits.maxCatalogAgeMs,
            marketIdentityDigests: members.sort(), kind: row.kind, entryVersion: sessionEntryVersion,
            membershipKnownSinceTs: catalogState.membershipKnownSinceTs,
          });
          if (row.admittedTs > asOfTs) futureCatalogControlsWithheld += 1;
          lastCatalog = catalogState;
        } else if (row.kind === 'SESSION_FINALIZATION') {
          sessionFinalizationCount += 1;
          if (sessionEntryVersion !== BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2
              || row.sessionId !== sessionId || row.sessionStartedTs !== Number(SESSION_RE.exec(sessionId)?.[1])
              || row.cutoffTs < row.sessionStartedTs || row.cutoffTs > row.admittedTs
              || row.lastDataOrdinal !== row.globalOrdinal - 1 || row.lastDataControlDigest !== row.previousControlDigest
              || row.activeCatalogContentId !== (lastCatalog?.contentId ?? null)
              || row.activeCatalogControlDigest !== (lastCatalog?.controlDigest ?? null)
              || !plain(row.admittedCounts) || exactKeys(row.admittedCounts, Object.keys(sessionCounts))
              || Object.keys(sessionCounts).some((key) => row.admittedCounts[key] !== sessionCounts[key])
              || !count(row.shardFiles) || !count(row.plannedPhysicalRows) || !count(row.plannedBytes)) fail('READER_FINALIZATION_INVALID', 'session finalization receipt does not bind the preceding session', { sessionId, ordinal: row.globalOrdinal });
          finalized = row; finalizationLineBytes = rowMeta.lineBytes;
        } else {
          const catalog = catalogs.get(row.catalogControlDigest);
          if (!catalog || catalog.contentId !== row.catalogContentId || catalog.admittedTs > row.admittedTs) fail('READER_CATALOG_REFERENCE_INVALID', 'record control does not reference a prior catalog control', { sessionId, ordinal: row.globalOrdinal });
          if (row.kind === 'SOURCE_CONTROL') {
            sourceControlCount += 1;
            sessionCounts.sourceControls += 1;
            const commonRecord = commonRecordError(row.record, row, sessionEntryVersion);
            const membership = recordMembershipError(row.record, catalog);
            const source = sourceControlError(row.record);
            if (commonRecord || membership || source) fail('READER_SOURCE_CONTROL_INVALID', commonRecord ?? membership ?? source, { sessionId, ordinal: row.globalOrdinal });
            const priorRecordDigest = seenRecordDigests.get(row.recordId);
            if (priorRecordDigest && priorRecordDigest !== row.recordDigest) fail('READER_RECORD_ID_COLLISION', 'one source record identity has altered bytes across archive sessions', { sessionId, ordinal: row.globalOrdinal });
            seenRecordDigests.set(row.recordId, row.recordDigest);
            if (row.record.recordType === 'GAP' && row.record.channel === 'ohlc') {
              const digest = archiveMarketDigest(row.record); const state = coverage.get(digest);
              if (state && row.knownAtTs <= asOfTs) state.gaps += 1;
            }
          } else {
            candleIndexCount += 1; sessionCounts.closedCandles += 1;
            if (!positive(row.periodStartTs) || !positive(row.periodEndTs) || row.periodEndTs - row.periodStartTs !== MINUTE
                || row.utcDate !== utcDate(row.periodStartTs) || !positive(row.shardOrdinal)
                || typeof row.conflict !== 'boolean' || row.knownAtTs !== row.admittedTs
                || row.receivedTs > row.knownAtTs || !HEX64.test(row.recordDigest ?? '')
                || !HEX64.test(row.marketIdentityDigest ?? '')) fail('READER_CANDLE_INDEX_INVALID', 'candle index fields malformed', { sessionId, ordinal: row.globalOrdinal });
            const member = catalog.catalog.markets.find((candidate) => marketDigest(marketIdentity(candidate)) === row.marketIdentityDigest);
            if (!member) fail('READER_CANDLE_INDEX_INVALID', 'index market absent from referenced catalog', { sessionId, ordinal: row.globalOrdinal });
            const key = `${row.marketIdentityDigest}:${row.utcDate}`;
            const fileName = `market-${row.marketIdentityDigest.slice(0, 24)}-${row.utcDate}.jsonl`;
            const meta = expectedShards.get(key) ?? {
              key, fileName, identityDigest: row.marketIdentityDigest, utcDate: row.utcDate,
              expectedRows: 0, expectedChain: 'GENESIS', nextOrdinal: 1,
              catalogControlDigests: [],
            };
            if (meta.fileName !== fileName || meta.nextOrdinal !== row.shardOrdinal) fail('READER_CANDLE_INDEX_INVALID', 'shard ordinal or identity changed', { sessionId, ordinal: row.globalOrdinal });
            meta.expectedRows += 1; meta.nextOrdinal += 1;
            meta.catalogControlDigests.push(row.catalogControlDigest);
            meta.expectedChain = chainDigest(meta.expectedChain, expectedShardSummary(row));
            expectedShards.set(key, meta);
          }
        }
        lastDigest = row.controlDigest; lastAdmittedTs = row.admittedTs; nextOrdinal += 1;
      },
    });
    totalBytes += controls.bytes; if (totalBytes > limits.maxTotalBytes) fail('READER_TOTAL_BYTE_LIMIT', 'archive exceeds aggregate byte bound');

    const expectedByFile = new Map();
    for (const meta of expectedShards.values()) {
      if (expectedByFile.has(meta.fileName)) fail('READER_SHARD_IDENTITY_COLLISION', 'two full market identities collide on one shard filename', { sessionId, fileName: meta.fileName });
      expectedByFile.set(meta.fileName, meta);
    }
    if (shardNames.length !== expectedByFile.size || shardNames.some((name) => !expectedByFile.has(name))) fail('READER_SHARD_INVENTORY_MISMATCH', 'control ledger and shard files do not match exactly', { sessionId });
    const shardMetas = [];
    for (const fileName of shardNames) {
      const expected = expectedByFile.get(fileName); const file = path.join(shardsDir, fileName);
      let actualChain = 'GENESIS'; let nextShardOrdinal = 1; let relevantInShard = 0;
      const scanned = await scanJsonl(file, {
        maxFileBytes: limits.maxShardBytes, maxLineBytes: limits.maxRecordLineBytes,
        maxRows: limits.maxShardRows,
        signal,
        onRow: async (row) => {
          const keys = exactKeys(row, SHARD_KEYS); if (keys) fail('READER_SHARD_ROW_INVALID', keys, { sessionId, fileName, row: nextShardOrdinal });
          if (row.entryVersion !== sessionEntryVersion || row.kind !== 'CLOSED_CANDLE'
              || row.shardOrdinal !== nextShardOrdinal || row.knownAtTs !== row.admittedTs
              || typeof row.conflict !== 'boolean' || !HEX64.test(row.globalControlDigest ?? '')
              || !HEX64.test(row.recordDigest ?? '')) fail('READER_SHARD_ROW_INVALID', 'shard identity/clocks malformed', { sessionId, fileName, row: nextShardOrdinal });
          const commonRecord = commonRecordError(row.record, { ...row, catalogContentId: row.record.catalogContentId, recordId: row.record.recordId }, sessionEntryVersion);
          const catalog = catalogs.get(expected.catalogControlDigests[nextShardOrdinal - 1]);
          const membership = catalog ? recordMembershipError(row.record, catalog, expected.identityDigest) : 'shard record catalog is not present in session controls';
          const closed = closedRecordError(row.record);
          if (commonRecord || membership || closed) fail('READER_SHARD_ROW_INVALID', commonRecord ?? membership ?? closed, { sessionId, fileName, row: nextShardOrdinal });
          if (archiveMarketDigest(row.record) !== expected.identityDigest || utcDate(row.record.periodStartTs) !== expected.utcDate) fail('READER_SHARD_ROW_INVALID', 'row belongs to a different shard identity/day', { sessionId, fileName, row: nextShardOrdinal });
          const location = `${sessionId}:${fileName}:${row.shardOrdinal}`;
          const priorRecordDigest = seenRecordDigests.get(row.record.recordId);
          if (priorRecordDigest && priorRecordDigest !== row.recordDigest) fail('READER_RECORD_ID_COLLISION', 'one candle record identity has altered bytes across archive sessions', { sessionId, fileName, row: nextShardOrdinal });
          const exactDuplicate = priorRecordDigest === row.recordDigest;
          seenRecordDigests.set(row.record.recordId, row.recordDigest);
          actualChain = chainDigest(actualChain, actualShardSummary(row)); nextShardOrdinal += 1; candleRowCount += 1;
          if (row.record.periodStartTs >= dayStartTs && row.record.periodStartTs < dayEndTs) {
            relevantRows += 1; relevantInShard += 1;
            if (sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2) canonicalV2CandleRows += 1;
            const state = coverage.get(expected.identityDigest); state.rows += 1; state.sessions.add(sessionId);
            if (exactDuplicate) { state.duplicateRows += 1; duplicateCandleRows += 1; }
            if (row.knownAtTs > asOfTs || row.record.recordedTs > asOfTs
                || catalog.membershipKnownSinceTs > row.record.periodStartTs) {
              state.futureWithheldRows += 1; futureWithheldRows += 1;
              if (catalog.membershipKnownSinceTs > row.record.periodStartTs) catalogAsOfWithheldRows += 1;
            } else if (!exactDuplicate || !state.eligibleRecordIds.has(row.record.recordId)) {
              state.eligibleRecordIds.add(row.record.recordId); eligibleCandleLocations.add(location);
              state.eligibleRows += 1; asOfEligibleRows += 1;
              const minute = (row.record.periodStartTs - dayStartTs) / MINUTE;
              if (!Number.isSafeInteger(minute) || minute < 0 || minute >= dayMinutes) fail('READER_SHARD_ROW_INVALID', 'candle is not aligned to the declared civil-day minute grid');
              if (row.conflict || state.minuteState[minute] > 0) {
                state.minuteState[minute] = 2; state.conflictRows += 1;
              } else state.minuteState[minute] = 1;
              state.firstPeriodStartTs = state.firstPeriodStartTs === null ? row.record.periodStartTs : Math.min(state.firstPeriodStartTs, row.record.periodStartTs);
              state.lastPeriodEndTs = state.lastPeriodEndTs === null ? row.record.periodEndTs : Math.max(state.lastPeriodEndTs, row.record.periodEndTs);
            }
          }
        },
      });
      if (scanned.rows !== expected.expectedRows || actualChain !== expected.expectedChain) fail('READER_SHARD_CONTROL_MISMATCH', 'shard rows do not exactly match the control ledger', { sessionId, fileName });
      totalBytes += scanned.bytes; if (totalBytes > limits.maxTotalBytes) fail('READER_TOTAL_BYTE_LIMIT', 'archive exceeds aggregate byte bound');
      shardMetas.push({
        sessionId, fileName, file, identityDigest: expected.identityDigest, utcDate: expected.utcDate,
        rows: scanned.rows, relevantRows: relevantInShard, bytes: scanned.bytes,
        digest: scanned.digest, fingerprint: scanned.fingerprint,
      });
    }
    const sourceDigest = sha256(canonicalBounded({
      sessionId, controlsDigest: controls.digest,
      shards: shardMetas.map((row) => ({ fileName: row.fileName, digest: row.digest, rows: row.rows, bytes: row.bytes })),
    }, 4 * 1024 * 1024).text);
    if (finalized) {
      const expectedPhysicalRows = finalized.lastDataOrdinal + sessionCounts.closedCandles;
      const expectedPhysicalBytes = controls.bytes - finalizationLineBytes + shardMetas.reduce((sum, shard) => sum + shard.bytes, 0);
      if (finalized.shardFiles !== shardMetas.length
          || finalized.plannedPhysicalRows !== expectedPhysicalRows
          || finalized.plannedBytes !== expectedPhysicalBytes) fail('READER_FINALIZATION_INVALID', 'session finalization physical counts do not match retained files', { sessionId });
    }
    sessionMetas.push({
      sessionId, controls: { file: controlFile, rows: controls.rows, bytes: controls.bytes, digest: controls.digest },
      shards: shardMetas, empty: false, sourceDigest, entryVersion: sessionEntryVersion,
      archiveVersion: sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 ? BROAD_DAY_ARCHIVE_VERSION_V2 : BROAD_DAY_ARCHIVE_VERSION,
      startedTs: Number(SESSION_RE.exec(sessionId)?.[1]), firstCatalogAdmittedTs: catalogObservations.filter((row) => row.sessionId === sessionId).at(0)?.admittedTs ?? null,
      finalized: finalized ? { ordinal: finalized.globalOrdinal, controlDigest: finalized.controlDigest, cutoffTs: finalized.cutoffTs, admittedTs: finalized.admittedTs } : null,
    });
  }

  const finalNames = readdirSync(sessionsRoot).sort();
  if (existsSync(path.join(archiveRoot, 'writer.lock')) || JSON.stringify(finalNames) !== JSON.stringify(initialNames)) fail('READER_ARCHIVE_CHANGED', 'archive ownership/session inventory changed during read');
  catalogObservations.sort((a, b) => a.admittedTs - b.admittedTs || a.sessionId.localeCompare(b.sessionId) || a.globalOrdinal - b.globalOrdinal);
  const knownCatalogObservations = catalogObservations.filter((row) => row.admittedTs <= asOfTs);
  const epochs = [];
  for (let i = 0; i < knownCatalogObservations.length; i += 1) {
    const observation = knownCatalogObservations[i];
    const activeUntilTs = knownCatalogObservations[i + 1]?.admittedTs ?? Number.MAX_SAFE_INTEGER;
    if (observation.admittedTs >= dayEndTs || activeUntilTs <= dayStartTs) continue;
    const expectedStart = Math.max(dayStartTs, observation.admittedTs);
    const expectedEnd = Math.min(dayEndTs, activeUntilTs);
    const startMinute = Math.max(0, Math.ceil((expectedStart - dayStartTs) / MINUTE));
    const endMinute = Math.min(dayMinutes, Math.ceil((expectedEnd - dayStartTs) / MINUTE));
    for (const digest of observation.marketIdentityDigests) {
      eligibleIdentities.add(digest); coverage.get(digest).catalogControls.add(observation.controlDigest);
      for (let minute = startMinute; minute < endMinute; minute += 1) coverage.get(digest).expectedMinuteState[minute] = 1;
    }
    if (observation.staleAtAdmission) staleCatalogControls += 1;
    epochs.push({ ...observation, activeUntilTs: Math.min(activeUntilTs, dayEndTs) });
  }

  const relevantSessions = sessionMetas.filter((session) => session.empty
    ? session.startedTs < dayEndTs
    : session.firstCatalogAdmittedTs !== null && session.firstCatalogAdmittedTs < dayEndTs
      && (session.finalized?.cutoffTs ?? Number.MAX_SAFE_INTEGER) > dayStartTs);
  const allRelevantSessionsV2 = relevantSessions.length > 0
    && relevantSessions.every((session) => session.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2);
  const sessionIntervals = relevantSessions.filter((session) => session.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 && session.finalized)
    .map((session) => ({ startTs: session.firstCatalogAdmittedTs, endTs: session.finalized.cutoffTs, sessionId: session.sessionId }))
    .sort((a, b) => a.startTs - b.startTs || a.sessionId.localeCompare(b.sessionId));
  let sessionCursor = dayStartTs;
  for (const interval of sessionIntervals) {
    if (interval.endTs <= sessionCursor) continue;
    if (interval.startTs > sessionCursor) break;
    sessionCursor = Math.max(sessionCursor, interval.endTs);
  }
  const sessionFinalizationVerified = allRelevantSessionsV2
    && relevantSessions.every((session) => session.finalized !== null) && sessionCursor >= dayEndTs;

  const scheduleStartIndex = knownCatalogObservations.findLastIndex((row) => row.admittedTs <= dayStartTs);
  let scheduleEndIndex = -1;
  if (scheduleStartIndex >= 0) {
    scheduleEndIndex = knownCatalogObservations.findIndex((row, index) => index >= scheduleStartIndex && row.admittedTs >= dayEndTs);
  }
  const schedule = scheduleStartIndex >= 0 && scheduleEndIndex >= scheduleStartIndex
    ? knownCatalogObservations.slice(scheduleStartIndex, scheduleEndIndex + 1) : [];
  let scheduleGapMaxMs = null;
  if (schedule.length > 1) scheduleGapMaxMs = schedule.slice(1).reduce((maximum, row, index) => Math.max(maximum, row.admittedTs - schedule[index].admittedTs), 0);
  const catalogHeartbeatContinuityVerified = schedule.length > 0
    && schedule.every((row) => row.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 && !row.staleAtAdmission)
    && schedule.slice(1).every((row, index) => row.sourceObservedTs >= schedule[index].sourceObservedTs)
    && schedule[0].admittedTs <= dayStartTs && schedule.at(-1).admittedTs >= dayEndTs
    && scheduleGapMaxMs !== null && scheduleGapMaxMs <= limits.maxCatalogHeartbeatGapMs;

  const siblingCounts = new Map();
  for (const [digest, identity] of identities) if (eligibleIdentities.has(digest)) siblingCounts.set(identity.canonicalCoin, (siblingCounts.get(identity.canonicalCoin) ?? 0) + 1);
  const publicCoverageRows = [...coverage.values()].filter((state) => eligibleIdentities.has(state.marketIdentityDigest)).map((state) => publicCoverage(state, dayStartTs, dayEndTs, siblingCounts.get(state.identity.canonicalCoin))).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest));
  const completeGrids = publicCoverageRows.filter((row) => row.gridState === 'COMPLETE_OBSERVED_GRID').length;
  const conflicts = publicCoverageRows.filter((row) => row.gridState === 'CONFLICT').length;
  const identityChanges = [...siblingCounts.values()].filter((value) => value > 1).length;
  const sourceRecordIdentityRecomputable = relevantRows > 0 && canonicalV2CandleRows === relevantRows;
  const fullPopulationVerified = sourceRecordIdentityRecomputable && sessionFinalizationVerified && catalogHeartbeatContinuityVerified && eligibleIdentities.size > 0;
  const allExpectedGridsComplete = publicCoverageRows.length === eligibleIdentities.size
    && publicCoverageRows.length > 0 && publicCoverageRows.every((row) => row.gridState === 'COMPLETE_OBSERVED_GRID' && row.expectedCatalogMembershipMinutes > 0);
  const fullDaySimulationReady = fullPopulationVerified && allExpectedGridsComplete
    && futureWithheldRows === 0 && catalogAsOfWithheldRows === 0
    && identityChanges === 0;
  const reasons = [];
  if (!sourceRecordIdentityRecomputable) reasons.push('SOURCE_RECORD_IDENTITY_NOT_CANONICALLY_RECOMPUTABLE_FOR_ALL_DAY_ROWS');
  if (!sessionFinalizationVerified) reasons.push('SESSION_FINALIZATION_OR_EXACT_CROSS_SESSION_COVERAGE_MISSING');
  if (!catalogHeartbeatContinuityVerified) reasons.push('CATALOG_HEARTBEAT_SCHEDULE_OR_BOUNDARY_PROOF_MISSING');
  if (sessionMetas.some((row) => row.empty)) reasons.push('EMPTY_ARCHIVE_SESSION_PRESENT');
  if (staleCatalogControls) reasons.push('STALE_CATALOG_CONTROL_PRESENT');
  if (futureWithheldRows) reasons.push('ROWS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (futureCatalogControlsWithheld) reasons.push('CATALOG_CONTROLS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (catalogAsOfWithheldRows) reasons.push('CANDLE_CATALOG_MEMBERSHIP_NOT_KNOWN_AT_PERIOD_START');
  if (conflicts) reasons.push('CONFLICTING_CANDLE_MINUTES_PRESENT');
  if (!allExpectedGridsComplete) {
    reasons.push('CANDLE_GRID_INCOMPLETE');
    reasons.push('CANDLE_GRID_INCOMPLETE_FOR_OBSERVED_MEMBERSHIP_EPOCHS');
  }
  if (identityChanges) reasons.push('CANONICAL_COIN_IDENTITY_CHANGED_ACROSS_OBSERVED_CATALOG_EPOCHS');

  const sessionSources = sessionMetas.map((session) => ({
    sessionId: session.sessionId, empty: session.empty, sourceDigest: session.sourceDigest,
    archiveVersion: session.archiveVersion ?? null, entryVersion: session.entryVersion ?? null,
    startedTs: session.startedTs ?? null, finalized: session.finalized,
    controlRows: session.controls?.rows ?? 0, controlBytes: session.controls?.bytes ?? 0,
    shards: session.shards.map((shard) => ({ fileName: shard.fileName, digest: shard.digest, rows: shard.rows, bytes: shard.bytes })),
  }));
  const descriptorBody = {
    datasetVersion: BROAD_DAY_DATASET_VERSION,
    archiveVersion: sessionMetas.some((row) => !row.empty)
      && sessionMetas.every((row) => row.empty || row.archiveVersion === BROAD_DAY_ARCHIVE_VERSION_V2)
      ? BROAD_DAY_ARCHIVE_VERSION_V2 : BROAD_DAY_ARCHIVE_VERSION,
    dayStartTs, dayEndTs, asOfTs,
    sourceProvenance: {
      sourceKind: allRelevantSessionsV2 ? 'LOCAL_BROAD_DAY_ARCHIVE_V2' : 'LOCAL_BROAD_DAY_ARCHIVE_MIXED_OR_V1',
      sourceRootDigest: sha256(archiveRoot), sessions: sessionSources,
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    },
    catalogEpochs: epochs,
    catalogUnion: [...identities.entries()].filter(([marketIdentityDigest]) => eligibleIdentities.has(marketIdentityDigest)).map(([marketIdentityDigest, identity]) => ({ marketIdentityDigest, market: identity })).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest)),
    coverage: publicCoverageRows,
    counters: {
      sessions: sessionMetas.length, emptySessions: sessionMetas.filter((row) => row.empty).length,
      catalogControls: catalogControlCount, catalogHeartbeats: catalogHeartbeatCount,
      sessionFinalizations: sessionFinalizationCount, futureCatalogControlsWithheld, staleCatalogControls, sourceControls: sourceControlCount,
      candleIndexes: candleIndexCount, candleRows: candleRowCount,
      civilDayRows: relevantRows, asOfEligibleCivilDayRows: asOfEligibleRows,
      futureAdmissionWithheldRows: futureWithheldRows, catalogAsOfWithheldRows, observedCatalogUnionMarkets: eligibleIdentities.size,
      exactDuplicateCandleRows: duplicateCandleRows,
      completeObservedMinuteGrids: completeGrids, conflictMarkets: conflicts,
      canonicalCoinsWithIdentityChanges: identityChanges, totalPhysicalBytes: totalBytes,
    },
    completeness: {
      physicalControlAndShardIntegrityVerified: true,
      sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite: sourceRecordIdentityRecomputable,
      observedCatalogEpochUnionConstructed: true,
      catalogEpochContinuityVerified: catalogHeartbeatContinuityVerified,
      catalogHeartbeatMaxObservedGapMs: scheduleGapMaxMs,
      catalogHeartbeatRequiredMaximumGapMs: limits.maxCatalogHeartbeatGapMs,
      sessionFinalizationVerified,
      fullPopulationVerified,
      fullDaySimulationReady,
      reasons: [...new Set(reasons)].sort(),
    },
    ordering: 'SESSION_ID_THEN_SHARD_FILENAME_THEN_PHYSICAL_SHARD_ORDINAL',
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
  };
  const datasetDigest = sha256(canonicalBounded(descriptorBody, 64 * 1024 * 1024).text);
  const descriptor = freeze({
    ...clone(descriptorBody), datasetDigest, datasetId: `bdd-${datasetDigest}`,
  });
  const pageShards = sessionMetas.flatMap((session) => session.shards).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.fileName.localeCompare(b.fileName));
  const marketPageShards = new Map(descriptor.catalogUnion.map((row) => [row.marketIdentityDigest, []]));
  for (const shard of pageShards) marketPageShards.get(shard.identityDigest)?.push(shard);
  let closed = false;

  const status = () => freeze({
    version: 'broad-day-reader-v1', state: closed ? 'CLOSED' : 'OPEN',
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    shards: pageShards.length, rows: descriptor.counters.asOfEligibleCivilDayRows,
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    fullDaySimulationReady: descriptor.completeness.fullDaySimulationReady, authority: 'NONE',
  });

  const assertInventoryUnchanged = () => {
    if (existsSync(path.join(archiveRoot, 'writer.lock'))
        || JSON.stringify(readdirSync(sessionsRoot).sort()) !== JSON.stringify(initialNames)) {
      fail('READER_ARCHIVE_CHANGED', 'archive ownership/session inventory changed after reader construction');
    }
    for (const session of sessionMetas) {
      const sessionDir = path.join(sessionsRoot, session.sessionId);
      const entries = readdirSync(sessionDir).sort();
      if (JSON.stringify(entries) !== JSON.stringify(['controls.jsonl', 'shards']) && !session.empty) {
        fail('READER_ARCHIVE_CHANGED', 'session inventory changed after reader construction', { sessionId: session.sessionId });
      }
      if (session.empty && JSON.stringify(entries) !== JSON.stringify(['shards'])) {
        fail('READER_ARCHIVE_CHANGED', 'empty session inventory changed after reader construction', { sessionId: session.sessionId });
      }
      const shardNames = readdirSync(path.join(sessionDir, 'shards')).sort();
      if (JSON.stringify(shardNames) !== JSON.stringify(session.shards.map((row) => row.fileName).sort())) {
        fail('READER_ARCHIVE_CHANGED', 'session shard inventory changed after reader construction', { sessionId: session.sessionId });
      }
    }
  };

  const scanProjectedPage = async ({ shards, cursor, maxRows, pageSignal }) => {
    let shardIndex = cursor?.shardIndex ?? 0; let rowOffset = cursor?.rowOffset ?? 0;
    const rows = []; let rowBytes = 0;
    let stopped = false; let nextShardIndex = shards.length; let nextRowOffset = 0;
    while (shardIndex < shards.length && !stopped) {
      const meta = shards[shardIndex]; let physicalRow = 0;
      if (rowOffset > meta.rows) fail('READER_CURSOR_INVALID', 'cursor rowOffset exceeds shard rows');
      const rescanned = await scanJsonl(meta.file, {
        maxFileBytes: limits.maxShardBytes, maxLineBytes: limits.maxRecordLineBytes, maxRows: limits.maxShardRows,
        signal: pageSignal ?? signal,
        onRow: async (entry) => {
          physicalRow += 1;
          if (physicalRow <= rowOffset || stopped) return;
          const location = `${meta.sessionId}:${meta.fileName}:${entry.shardOrdinal}`;
          if (!eligibleCandleLocations.has(location)) return;
          if (entry.record.periodStartTs < dayStartTs || entry.record.periodStartTs >= dayEndTs
              || entry.knownAtTs > asOfTs || entry.record.recordedTs > asOfTs) return;
          const projected = pageRow(entry, meta.sessionId, meta.fileName);
          const projectedBytes = Buffer.byteLength(canonicalBounded(projected, limits.maxRecordLineBytes).text, 'utf8') + 1;
          if (rows.length >= maxRows || rowBytes + projectedBytes > limits.maxPageBytes) {
            if (rows.length === 0) fail('READER_PAGE_LIMIT', 'one projected row exceeds the page-byte bound');
            stopped = true; nextShardIndex = shardIndex; nextRowOffset = physicalRow - 1; return;
          }
          rows.push(projected); rowBytes += projectedBytes;
          nextShardIndex = shardIndex; nextRowOffset = physicalRow;
        },
      });
      if (rescanned.digest !== meta.digest || rescanned.bytes !== meta.bytes || rescanned.rows !== meta.rows) fail('READER_FILE_CHANGED', 'verified shard changed before/during page read', { sessionId: meta.sessionId, fileName: meta.fileName });
      if (!stopped) { shardIndex += 1; rowOffset = 0; nextShardIndex = shardIndex; nextRowOffset = 0; }
    }
    return { rows, rowBytes, nextShardIndex, nextRowOffset, done: nextShardIndex >= shards.length };
  };

  const readPage = async ({ cursor = null, maxRows = limits.maxPageRows, signal: pageSignal = null } = {}) => {
    if (closed) fail('READER_CLOSED', 'reader is closed');
    const pageAbortError = signalError(pageSignal); if (pageAbortError) fail('READER_ARGUMENT_INVALID', pageAbortError);
    throwIfCancelled(signal); throwIfCancelled(pageSignal);
    const cursorErr = cursorError(cursor, descriptor, pageShards.length); if (cursorErr) fail('READER_CURSOR_INVALID', cursorErr);
    if (!positive(maxRows) || maxRows > limits.maxPageRows) fail('READER_PAGE_LIMIT', 'maxRows outside configured bound');
    assertInventoryUnchanged();
    const scanned = await scanProjectedPage({ shards: pageShards, cursor, maxRows, pageSignal });
    assertInventoryUnchanged();
    const { rows, rowBytes, nextShardIndex, nextRowOffset, done } = scanned;
    const priorEmitted = cursor?.emittedRows ?? 0;
    const nextCursor = {
      cursorVersion: BROAD_DAY_CURSOR_VERSION, datasetDigest: descriptor.datasetDigest,
      shardIndex: done ? pageShards.length : nextShardIndex,
      rowOffset: done ? 0 : nextRowOffset,
      emittedRows: priorEmitted + rows.length,
      cursorDigest: '',
    };
    nextCursor.cursorDigest = digestWithout(nextCursor, 'cursorDigest', 4_096);
    const body = {
      pageVersion: BROAD_DAY_PAGE_VERSION, datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, cursor, nextCursor, done,
      rows, rowBytes, rowCount: rows.length,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const pageDigest = sha256(canonicalBounded(body, limits.maxPageBytes + 512 * 1024).text);
    return freeze({ ...body, pageDigest });
  };

  const readMarketPage = async ({ marketIdentityDigest, cursor = null, maxRows = limits.maxPageRows, signal: pageSignal = null } = {}) => {
    if (closed) fail('READER_CLOSED', 'reader is closed');
    const pageAbortError = signalError(pageSignal); if (pageAbortError) fail('READER_ARGUMENT_INVALID', pageAbortError);
    throwIfCancelled(signal); throwIfCancelled(pageSignal);
    if (!HEX64.test(marketIdentityDigest ?? '') || !marketPageShards.has(marketIdentityDigest)) {
      fail('READER_MARKET_INVALID', 'market identity is absent from the sealed dataset denominator');
    }
    const shards = marketPageShards.get(marketIdentityDigest);
    const cursorErr = marketCursorError(cursor, descriptor, marketIdentityDigest, shards.length);
    if (cursorErr) fail('READER_CURSOR_INVALID', cursorErr);
    if (!positive(maxRows) || maxRows > limits.maxPageRows) fail('READER_PAGE_LIMIT', 'maxRows outside configured bound');
    assertInventoryUnchanged();
    const scanned = await scanProjectedPage({ shards, cursor, maxRows, pageSignal });
    assertInventoryUnchanged();
    const { rows, rowBytes, nextShardIndex, nextRowOffset, done } = scanned;
    if (rows.some((row) => row.marketIdentityDigest !== marketIdentityDigest)) {
      fail('READER_MARKET_PAGE_INVALID', 'market page crossed the requested identity boundary');
    }
    const priorEmitted = cursor?.emittedRows ?? 0;
    const nextCursor = {
      cursorVersion: BROAD_DAY_MARKET_CURSOR_VERSION, datasetDigest: descriptor.datasetDigest,
      marketIdentityDigest, shardIndex: done ? shards.length : nextShardIndex,
      rowOffset: done ? 0 : nextRowOffset, emittedRows: priorEmitted + rows.length,
      cursorDigest: '',
    };
    nextCursor.cursorDigest = digestWithout(nextCursor, 'cursorDigest', 4_096);
    const body = {
      pageVersion: BROAD_DAY_MARKET_PAGE_VERSION, datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, marketIdentityDigest,
      cursor, nextCursor, done, rows, rowBytes, rowCount: rows.length,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const pageDigest = sha256(canonicalBounded(body, limits.maxPageBytes + 512 * 1024).text);
    return freeze({ ...body, pageDigest });
  };

  const close = () => { closed = true; return status(); };
  return Object.freeze({ version: 'broad-day-reader-v1', descriptor, readPage, readMarketPage, status, close });
}
