// FORWARD-SHADOW LANE — the deterministic market-capture-to-shadow adapter. It consumes the market-lab owner's
// SEALED capture bundles (manifest-last, per-member sha256) and normalized observations WITHOUT importing any
// market-lab module: the learning fence forbids the import, so this file MIRRORS the byte formats it reads and
// verifies integrity itself — the same mirror-without-import pattern learning/labels.js uses. A PARITY TEST
// (test/shadow-adapter.test.js) imports the REAL market-lab contracts and proves every mirrored constant and
// identity below against them, so drift fails loudly.
//
// Laws:
//   - INTEGRITY FIRST: BOTH sealed members this adapter consumes — observations.jsonl AND coverage.jsonl —
//     must hash to the manifest's sha256 and match its byte count; a truncated/partial or altered member, a
//     duplicated observation id, or an oversized segment refuses the WHOLE bundle with the reason.
//   - QUALITY PARITY (review P0): the market contracts have NO 'FINAL' state. A decision-grade candle is
//     quality.state 'KNOWN' with payload.closed === true and provisional !== true — exactly what the real
//     Kraken/Coinbase normalizers emit for committed bars. PROVISIONAL bars never enter.
//   - COVERAGE LAW (review P0): observations alone do not prove completeness. Trade-flow is attached ONLY
//     over intervals the sealed coverage records prove complete (OBSERVED/SUBSCRIBED cover, no overlapping
//     GAP/FAILED/DROPPED/EVICTED and no PAGINATION/ACQUISITION-incomplete reason); a PROVEN-complete interval
//     with zero trades is a REAL zero flow. A candle overlapped by an incomplete CANDLE-family interval is
//     excluded (the capture law then reports the gap). A depth snapshot is admissible only under the KNOWN
//     synchronized book law: quality KNOWN, payload.synchronized === true, checksum not failed, and no later
//     DESYNCHRONIZED/GAP book-coverage fact standing at its clock.
//   - NO INVENTED CLOCKS: every candle's knownAtTs is the observation's own receipt-derived knownAtTs; the
//     decision clock of an opportunity is the LATEST knownAtTs of its frozen window. One REST receipt stamping
//     many candles yields DISTINCT opportunities per window (identity carries the window end), ordered by
//     decision clock then NEWEST window first — the stale window is never captured ahead of the fresh one.
//   - NO ZERO-FILL: an unobserved volume component stays absent (Coinbase reports base volume with a null
//     quote — the real component passes through, nothing synthesizes the other); no trades + no coverage
//     proof = no flow; no snapshot = no depth. Absence is absence.
//   - BOUNDED BYTES, HONESTLY STATED: members above the strict per-member byte/row bounds are refused by
//     name, and the caller's physical-read budget includes the manifest plus both members. The reader checks
//     that total before opening either member and refuses size changes while reading. These bounds cap BYTES,
//     not wall time — parsing is synchronous; worker/streaming isolation remains the next step if hosts need
//     hard wall-time guarantees. No "never jams" claim is made.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { deepFreeze, isPlainObject, isTs, isFiniteNum } from './shadow-contracts.js';

export const ADAPTER_VERSION = 'shadow-market-adapter-2';
// ---- mirrored market-lab constants (each proven against the real contracts by the parity test) ---------------
export const MIRRORED_OBSERVATION_SCHEMA = 'market-observation-1';
export const MIRRORED_BUNDLE_KIND = 'CAPTURE';
export const MIRRORED_BUNDLE_VERSION = 'market-capture-bundle-1';
export const MIRRORED_COVERAGE_VERSION = 'market-coverage-1';
export const MIRRORED_CANDLE_QUALITY = 'KNOWN'; // the market contracts have NO 'FINAL' state
export const MIRRORED_COMPLETE_COVER_STATES = Object.freeze(['OBSERVED', 'SUBSCRIBED']);
export const MIRRORED_BROKEN_COVER_STATES = Object.freeze(['GAP', 'FAILED', 'DROPPED', 'EVICTED', 'ACCESS_BLOCKED']);
export const MIRRORED_INCOMPLETE_REASONS = Object.freeze(['PAGINATION_INCOMPLETE', 'ACQUISITION_INCOMPLETE', 'CENSUS_INCOMPLETE']);
export const MIRRORED_DESYNC_BOOK_STATES = Object.freeze(['DESYNCHRONIZED', 'GAP', 'UNSUBSCRIBED']);
const MINUTE = 60_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_SEGMENT_BYTES = 8 * 1024 * 1024; // strict per-member cap: a byte bound, not a wall-time guarantee
export const MAX_SEGMENT_ROWS = 50_000;

// market-lab's canonical JSON (keys sorted, UNDEFINED DROPPED, no whitespace) — parity-tested byte-for-byte
export const mirrorCanonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(mirrorCanonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${mirrorCanonicalJson(v[k])}`)).filter(Boolean).join(',')}}`;
};
export const mirrorSubjectId = (subject) => `ms-${createHash('sha256').update(mirrorCanonicalJson(subject)).digest('hex').slice(0, 32)}`;

// A stat is only a preflight hint: a file can change between stat and read. Read through an explicit byte-sized
// buffer, then fstat the same descriptor again. Growth, shrinkage and replacement are refused rather than letting
// a whole-file helper allocate/read past the caller's remaining budget.
function readPhysicalFileBounded(file, maxBytes) {
  let fd; let bytesRead = 0;
  try {
    fd = openSync(file, 'r');
    const before = fstatSync(fd);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      return { ok: false, refused: 'INPUT_BYTE_BUDGET_EXCEEDED', detail: 'file exceeds the bounded read allowance', bytesRead: 0, requiredBytes: before.size };
    }
    const bytes = Buffer.alloc(before.size);
    while (bytesRead < bytes.length) {
      const n = readSync(fd, bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!n) return { ok: false, refused: 'FILE_CHANGED_DURING_BOUNDED_READ', detail: 'file shrank during bounded read', bytesRead };
      bytesRead += n;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size) return { ok: false, refused: 'FILE_CHANGED_DURING_BOUNDED_READ', detail: 'file size changed during bounded read', bytesRead };
    return { ok: true, bytes, bytesRead };
  } catch (err) {
    return { ok: false, refused: 'FILE_UNREADABLE', detail: err.message, bytesRead };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---- sealed-bundle mirror reader ------------------------------------------------------------------------------
function sealedMemberInfo(dir, manifest, name) {
  const member = manifest.members.find((m) => m?.name === name);
  if (!member || !/^[0-9a-f]{64}$/.test(String(member.sha256)) || !Number.isSafeInteger(member.bytes) || member.bytes < 0) return { refused: `${name.toUpperCase().replace(/[^A-Z]/g, '_')}_MEMBER_MISSING`, detail: `the manifest names no verifiable ${name} member` };
  const file = path.join(dir, name);
  if (!existsSync(file)) return { refused: `${name.toUpperCase().replace(/[^A-Z]/g, '_')}_MEMBER_MISSING`, detail: file };
  const physicalBytes = statSync(file).size;
  if (member.bytes > MAX_SEGMENT_BYTES || physicalBytes > MAX_SEGMENT_BYTES) return { refused: 'SEGMENT_TOO_LARGE_FOR_SYNC_READ', detail: `${name} exceeds ${MAX_SEGMENT_BYTES} bytes — the owner must shard segments; this adapter will not jam the host thread` };
  return { member, file, physicalBytes };
}

function readSealedMember(info, name) {
  const { member, file, physicalBytes } = info;
  const read = readPhysicalFileBounded(file, physicalBytes);
  if (!read.ok) return { refused: read.refused === 'INPUT_BYTE_BUDGET_EXCEEDED' ? 'FILE_CHANGED_DURING_BOUNDED_READ' : read.refused, detail: read.detail, bytesRead: read.bytesRead };
  const { bytes } = read;
  if (bytes.length !== member.bytes) return { refused: `${name === 'coverage.jsonl' ? 'COVERAGE' : 'OBSERVATIONS'}_TRUNCATED_OR_EXTENDED`, detail: `${bytes.length} bytes on disk vs ${member.bytes} sealed`, bytesRead: read.bytesRead };
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== member.sha256) return { refused: `${name === 'coverage.jsonl' ? 'COVERAGE' : 'OBSERVATIONS'}_DIGEST_MISMATCH`, detail: `sha256 ${digest.slice(0, 12)}… vs sealed ${String(member.sha256).slice(0, 12)}…`, bytesRead: read.bytesRead };
  const rows = [];
  let lineNo = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    if (rows.length >= MAX_SEGMENT_ROWS) return { refused: 'SEGMENT_TOO_LARGE_FOR_SYNC_READ', detail: `${name} exceeds ${MAX_SEGMENT_ROWS} rows`, bytesRead: read.bytesRead };
    let row;
    try { row = JSON.parse(line); } catch { return { refused: 'ROW_MALFORMED', detail: `${name} line ${lineNo} is not JSON`, bytesRead: read.bytesRead }; }
    rows.push(row);
  }
  if (Number.isSafeInteger(member.lines) && member.lines !== rows.length) return { refused: `${name === 'coverage.jsonl' ? 'COVERAGE' : 'OBSERVATIONS'}_TRUNCATED_OR_EXTENDED`, detail: `${rows.length} rows vs ${member.lines} sealed lines`, bytesRead: read.bytesRead };
  return { rows, bytesRead: read.bytesRead };
}

// `maxInputBytes` is a strict physical-read ceiling across manifest + both sealed members. The manifest is read
// first under the same ceiling, then both member sizes are preflighted together before either member is opened.
export function readSealedMarketCapture(dir, { maxInputBytes = Infinity } = {}) {
  const refuse = (refused, detail, bytesRead = 0, requiredBytes = null) => deepFreeze({ ok: false, refused, detail: String(detail).slice(0, 300), bytesRead, requiredBytes });
  if (typeof dir !== 'string' || !dir.length) return refuse('BUNDLE_UNREADABLE', 'a bundle directory is required');
  if (maxInputBytes !== Infinity && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0)) return refuse('INPUT_BYTE_BUDGET_INVALID', 'maxInputBytes must be a non-negative safe integer');
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) return refuse('MANIFEST_MISSING', manifestFile);
  const manifestRead = readPhysicalFileBounded(manifestFile, Math.min(MAX_MANIFEST_BYTES, maxInputBytes));
  if (!manifestRead.ok) {
    const budgetTooSmall = manifestRead.refused === 'INPUT_BYTE_BUDGET_EXCEEDED'
      && Number.isSafeInteger(manifestRead.requiredBytes) && manifestRead.requiredBytes > maxInputBytes;
    const reason = budgetTooSmall ? 'INPUT_BYTE_BUDGET_EXCEEDED' : 'MANIFEST_UNREADABLE';
    return refuse(reason, manifestRead.detail, manifestRead.bytesRead, manifestRead.requiredBytes ?? null);
  }
  let manifest;
  try { manifest = JSON.parse(manifestRead.bytes.toString('utf8')); } catch (err) { return refuse('MANIFEST_UNREADABLE', err.message, manifestRead.bytesRead); }
  if (!isPlainObject(manifest) || manifest.bundleKind !== MIRRORED_BUNDLE_KIND || manifest.bundleVersion !== MIRRORED_BUNDLE_VERSION || !Array.isArray(manifest.members)) return refuse('NOT_A_SEALED_CAPTURE_BUNDLE', `kind=${manifest?.bundleKind} version=${manifest?.bundleVersion}`, manifestRead.bytesRead);
  let observationsInfo; let coverageInfo;
  try {
    observationsInfo = sealedMemberInfo(dir, manifest, 'observations.jsonl');
    if (observationsInfo.refused) return refuse(observationsInfo.refused, observationsInfo.detail, manifestRead.bytesRead);
    coverageInfo = sealedMemberInfo(dir, manifest, 'coverage.jsonl');
    if (coverageInfo.refused) return refuse(coverageInfo.refused, coverageInfo.detail, manifestRead.bytesRead);
  } catch (err) {
    return refuse('BUNDLE_UNREADABLE', err.message, manifestRead.bytesRead);
  }
  const requiredBytes = manifestRead.bytesRead + observationsInfo.physicalBytes + coverageInfo.physicalBytes;
  if (requiredBytes > maxInputBytes) return refuse('INPUT_BYTE_BUDGET_EXCEEDED', 'sealed bundle exceeds the remaining input-byte allowance', manifestRead.bytesRead, requiredBytes);
  const observations = readSealedMember(observationsInfo, 'observations.jsonl');
  if (observations.refused) return refuse(observations.refused, observations.detail, manifestRead.bytesRead + (observations.bytesRead ?? 0), requiredBytes);
  const coverage = readSealedMember(coverageInfo, 'coverage.jsonl');
  if (coverage.refused) return refuse(coverage.refused, coverage.detail, manifestRead.bytesRead + observations.bytesRead + (coverage.bytesRead ?? 0), requiredBytes);
  const bytesRead = manifestRead.bytesRead + observations.bytesRead + coverage.bytesRead;
  const seenIds = new Set();
  for (const row of observations.rows) {
    if (!isPlainObject(row) || row.schemaVersion !== MIRRORED_OBSERVATION_SCHEMA || typeof row.observationId !== 'string') return refuse('OBSERVATION_ROW_MALFORMED', `schema ${row?.schemaVersion}`, bytesRead, requiredBytes);
    if (seenIds.has(row.observationId)) return refuse('DUPLICATE_OBSERVATION_ID', row.observationId, bytesRead, requiredBytes); // one sealed fact appears once
    seenIds.add(row.observationId);
  }
  for (const c of coverage.rows) if (!isPlainObject(c) || c.recordVersion !== MIRRORED_COVERAGE_VERSION) return refuse('COVERAGE_ROW_MALFORMED', `recordVersion ${c?.recordVersion}`, bytesRead, requiredBytes);
  return deepFreeze({ ok: true, bundleId: manifest.bundleId ?? null, rows: observations.rows, coverage: coverage.rows, observationCount: observations.rows.length, bytesRead });
}

// ---- coverage interval law ------------------------------------------------------------------------------------
// complete([records], startTs, endTs): the interval is PROVEN complete iff the union of intact complete-cover
// intervals covers [startTs, endTs] and no broken/incomplete record overlaps it. SUBSCRIBED with endTs null is
// an open interval (feed continuity stands until something closes it).
export function intervalProvenComplete(records, startTs, endTs) {
  const overlaps = (r) => r.startTs < endTs && (r.endTs === null || r.endTs > startTs);
  for (const r of records) {
    if (!overlaps(r)) continue;
    if (MIRRORED_BROKEN_COVER_STATES.includes(r.state)) return false;
    if (Array.isArray(r.reasonCodes) && r.reasonCodes.some((x) => MIRRORED_INCOMPLETE_REASONS.includes(x))) return false;
  }
  const covers = records.filter((r) => MIRRORED_COMPLETE_COVER_STATES.includes(r.state) && overlaps(r))
    .map((r) => ({ s: Math.max(r.startTs, startTs), e: r.endTs === null ? endTs : Math.min(r.endTs, endTs) }))
    .sort((a, b) => a.s - b.s);
  let at = startTs;
  for (const c of covers) { if (c.s > at) return false; at = Math.max(at, c.e); if (at >= endTs) return true; }
  return at >= endTs;
}

// ---- normalization: observation rows -> lane candles / trade-flow / depth for ONE market -----------------------
const marketMatches = (row, { venue, canonicalCoin }) => isPlainObject(row.subject)
  && row.subject.subjectKind === 'MARKET' && row.subject.canonicalCoin === canonicalCoin && row.subject.venue === venue;

export function normalizeMarketRows({ rows, coverage = [] }, { venue, canonicalCoin, candlePeriodMs = MINUTE }) {
  const candles = []; const trades = []; const depths = []; const bookStates = [];
  const subjectIds = new Set();
  const granularityCensus = {}; // observed intervalMs -> row count: a declared-granularity mismatch is REPORTED, never silent
  for (const row of rows) {
    if (!marketMatches(row, { venue, canonicalCoin })) continue;
    subjectIds.add(mirrorSubjectId(row.subject));
    if (!isTs(row.knownAtTs) || !isTs(row.receivedTs) || row.knownAtTs < row.receivedTs) continue; // a clockless row is not evidence
    if (row.kind === 'CANDLE') {
      const p = row.payload;
      if (!isPlainObject(p) || p.closed !== true || p.provisional === true) continue;
      if (row.quality?.state !== MIRRORED_CANDLE_QUALITY) continue; // KNOWN, per the REAL vocabulary — 'FINAL' does not exist
      if (isTs(row.periodStartTs) && isTs(row.periodEndTs)) { const g = row.periodEndTs - row.periodStartTs; granularityCensus[g] = (granularityCensus[g] ?? 0) + 1; }
      // the DECLARED granularity law: the recipe names which bars it consumes (60s Kraken, 3600s Coinbase, ...);
      // bars of another granularity are counted in the census and reported as incompatible scope, never mixed in
      if (!isTs(row.periodStartTs) || !isTs(row.periodEndTs) || row.periodEndTs - row.periodStartTs !== candlePeriodMs) continue;
      if (isFiniteNum(p.intervalMs) && p.intervalMs !== candlePeriodMs) continue;
      if (![p.open, p.high, p.low, p.close].every((v) => isFiniteNum(v) && v > 0)) continue; // a no-trade candle (null prices) is not a decision candle
      candles.push({
        periodStartTs: row.periodStartTs, periodEndTs: row.periodEndTs,
        open: p.open, high: p.high, low: p.low, close: p.close,
        volumeBase: isFiniteNum(p.volumeBase) ? p.volumeBase : undefined, // an unobserved component stays ABSENT — never zero, never synthesized
        volumeQuote: isFiniteNum(p.volumeQuote) ? p.volumeQuote : undefined,
        closed: true, knownAtTs: row.knownAtTs,
      });
    } else if (row.kind === 'TRADE') {
      const p = row.payload;
      if (!isPlainObject(p) || !isFiniteNum(p.price) || !isFiniteNum(p.qty) || !['BUY', 'SELL'].includes(p.takerSide)) continue;
      trades.push({ ts: row.sourceEventTs ?? row.receivedTs, knownAtTs: row.knownAtTs, signedQty: p.takerSide === 'BUY' ? p.qty : -p.qty, qty: p.qty });
    } else if (row.kind === 'BOOK_SNAPSHOT') {
      const p = row.payload;
      if (!isPlainObject(p) || !Array.isArray(p.bids) || !Array.isArray(p.asks)) continue;
      // the KNOWN synchronized book law: a PARTIAL, desynchronized or checksum-failed snapshot is not depth
      if (row.quality?.state !== 'KNOWN' || p.synchronized !== true || p.checksumVerified === false) continue;
      depths.push({ bids: p.bids, asks: p.asks, knownAtTs: row.knownAtTs });
    } else if (row.kind === 'BOOK_COVERAGE') {
      const p = row.payload;
      if (isPlainObject(p) && typeof p.state === 'string') bookStates.push({ state: p.state, knownAtTs: row.knownAtTs });
    }
  }
  const covFor = (kind) => coverage.filter((r) => subjectIds.has(r.subjectId) && r.kind === kind);
  const candleCov = covFor('CANDLE'); const tradeCov = covFor('TRADE');
  const bookCov = coverage.filter((r) => subjectIds.has(r.subjectId) && ['BOOK_SNAPSHOT', 'BOOK_COVERAGE'].includes(r.kind));
  candles.sort((a, b) => a.periodStartTs - b.periodStartTs || a.knownAtTs - b.knownAtTs);
  const byPeriod = new Map();
  for (const c of candles) if (!byPeriod.has(c.periodStartTs)) byPeriod.set(c.periodStartTs, c); // the EARLIEST-known committed bar stands; later revisions never rewrite known history
  let uniq = [...byPeriod.values()];
  // FAIL CLOSED (review item 4): a candle is decision evidence ONLY inside an interval the sealed coverage
  // PROVES complete — absent coverage proves nothing, so absent coverage admits nothing
  uniq = uniq.filter((c) => intervalProvenComplete(candleCov, c.periodStartTs, c.periodEndTs));
  // trade-flow: only over intervals the sealed coverage PROVES complete. A proven-complete interval with zero
  // trades is a REAL zero (the SUBSCRIBED-continuity law); an unproven interval yields NO flow at all.
  for (const c of uniq) {
    const proven = tradeCov.length > 0 && intervalProvenComplete(tradeCov, c.periodStartTs, c.periodEndTs);
    if (!proven) continue;
    const inPeriod = trades.filter((t) => isTs(t.ts) && t.ts >= c.periodStartTs && t.ts < c.periodEndTs);
    const gross = inPeriod.reduce((a, t) => a + t.qty, 0);
    const net = inPeriod.reduce((a, t) => a + t.signedQty, 0);
    c.tradeFlow = gross > 0 ? Math.round((net / gross) * 1e6) / 1e6 : 0;
    if (inPeriod.length) c.knownAtTs = Math.max(c.knownAtTs, ...inPeriod.map((t) => t.knownAtTs)); // the flow (and so the candle) is fully known only when its last contributing trade was
  }
  // depth admissibility at the snapshot's OWN clock: the standing book fact (from the observation stream)
  // must not be desynchronized there. Later gaps are handled at USE time via bookBreaks (below): a snapshot
  // taken before a gap can never serve a decision made after it.
  bookStates.sort((a, b) => a.knownAtTs - b.knownAtTs);
  const admissibleDepths = depths.filter((d) => {
    const standing = [...bookStates].reverse().find((s) => s.knownAtTs <= d.knownAtTs);
    return !standing || !MIRRORED_DESYNC_BOOK_STATES.includes(standing.state);
  });
  admissibleDepths.sort((a, b) => a.knownAtTs - b.knownAtTs);
  // book BREAK intervals, from BOTH real sources (review item 4): the sealed coverage.jsonl records for the
  // book kinds (broken states / incomplete reasons), AND the observation-stream BOOK_COVERAGE facts (a
  // desync opens a break that the next SYNCHRONIZED fact closes)
  const bookBreaks = [];
  for (const r of bookCov) {
    const broken = MIRRORED_BROKEN_COVER_STATES.includes(r.state) || (Array.isArray(r.reasonCodes) && r.reasonCodes.some((x) => MIRRORED_INCOMPLETE_REASONS.includes(x) || x === 'DESYNCHRONIZED'));
    if (broken) bookBreaks.push({ startTs: r.startTs, endTs: r.endTs ?? null });
  }
  for (let i = 0; i < bookStates.length; i += 1) {
    if (!MIRRORED_DESYNC_BOOK_STATES.includes(bookStates[i].state)) continue;
    const next = bookStates.slice(i + 1).find((sf) => sf.state === 'SYNCHRONIZED');
    bookBreaks.push({ startTs: bookStates[i].knownAtTs, endTs: next ? next.knownAtTs : null });
  }
  return deepFreeze({ candles: uniq, depths: admissibleDepths, bookBreaks, tradeCount: trades.length, granularityCensus, declaredPeriodMs: candlePeriodMs });
}

// ---- deterministic opportunity extraction ----------------------------------------------------------------------
// Ordered by decision clock ascending, then NEWEST window first at an equal clock (one REST receipt stamps many
// candles with the same knownAt: the stale window must never be captured ahead of the fresh one), then the
// immutable window identity. afterCursor is the COMPOSITE restart cursor { lastDecisionTs, lastWindowEndTs }:
// within one decision clock, windows are processed newest-first, so the consumed set at the cursor's clock is
// exactly the windows ending AT OR AFTER lastWindowEndTs — a scalar clock would drop same-clock siblings.
export function extractShadowOpportunities({ normalized, recipe, venue, canonicalCoin, afterCursor = null, afterDecisionTs = null, maxOpportunities = 1000 }) {
  const w = recipe.candleWindowMin;
  const out = [];
  const { candles, depths, bookBreaks = [] } = normalized;
  const cursor = afterCursor ?? (afterDecisionTs !== null ? { lastDecisionTs: afterDecisionTs, lastWindowEndTs: -Infinity } : null);
  const consumed = (decisionTs, windowEndTs) => cursor !== null
    && (decisionTs < cursor.lastDecisionTs || (decisionTs === cursor.lastDecisionTs && windowEndTs >= (cursor.lastWindowEndTs ?? -Infinity)));
  for (let i = w - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - w + 1, i + 1);
    let contiguous = true;
    for (let j = 1; j < window.length; j += 1) if (window[j].periodStartTs !== window[j - 1].periodEndTs) { contiguous = false; break; }
    if (!contiguous) continue; // a gapped window is simply not an opportunity here; the capture law would refuse it anyway
    const decisionTs = Math.max(...window.map((c) => c.knownAtTs));
    const windowEndTs = window[window.length - 1].periodEndTs;
    if (consumed(decisionTs, windowEndTs)) continue; // already-consumed history is never re-presented as fresh
    if (decisionTs - windowEndTs > recipe.maxInputAgeMs) continue; // received too late to have been a live decision
    // depth at USE time: fresh, known before the decision, AND no book break stands between its clock and the
    // decision — a snapshot taken before a later gap/desync can never serve this decision (review item 4)
    const depth = [...depths].reverse().find((d) => d.knownAtTs <= decisionTs && decisionTs - d.knownAtTs <= recipe.maxInputAgeMs
      && !bookBreaks.some((b) => b.startTs <= decisionTs && (b.endTs === null || b.endTs > d.knownAtTs) && b.startTs >= d.knownAtTs)) ?? null;
    out.push(deepFreeze({ venue, assetId: canonicalCoin, decisionTs, windowEndTs, inputs: { candles: window, ...(depth ? { depth } : {}) } }));
  }
  out.sort((a, b) => a.decisionTs - b.decisionTs || b.windowEndTs - a.windowEndTs || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  return deepFreeze(out.slice(0, maxOpportunities));
}

// ---- maturation paths from LATER actually received observations ------------------------------------------------
export function extractMaturationPaths({ normalized, captures, asOfTs }) {
  const paths = {};
  for (const capture of captures) {
    const period = capture.inputUnits?.candlePeriodMs ?? MINUTE; // the capture's frozen granularity
    const bound = Math.ceil(capture.decisionTs / period) * period;
    const pathCandles = normalized.candles.filter((c) => c.periodStartTs >= bound && c.knownAtTs > capture.decisionTs && c.knownAtTs <= asOfTs);
    if (pathCandles.length) paths[capture.captureId] = { candles: pathCandles };
  }
  return deepFreeze(paths);
}
