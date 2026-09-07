// SOCIAL-5B §8 — the STRICT, BOUNDED census of an EXISTING immutable Childhood archive (childhood/build.js format,
// childhood/validate.js laws). It inspects only the explicitly supplied directory: never fetches, rebuilds, promotes,
// repairs in place or overwrites. Manifest version / identity and every declared candle checksum are verified against
// the exact bytes (the manifest's sourceChecksumsSha256_16 convention) and full SHA256 digests of every consumed file
// are retained. Missing declared files, contradictory checksums or malformed records are CORRUPT input, never NO_DATA;
// a manifest that lawfully declares no usable 1m history is unavailable coverage, never a license to manufacture it.
// Only the raw 1m track is loaded into memory (bounded per series); coarser tracks are counted by streaming and stay
// visible in the census but are never substituted or interpolated into labels.
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { EXPECTED_SCHEMA_VERSION, CHILDHOOD_VERSION } from '../childhood/validate.js';
import { LIMITS, fail, isPlainObject, isTs, isFiniteNum, parseUtcInstant, readPath, deepFreeze } from './contracts.js';
import { readJsonFile, readJsonlStrict, readBoundedFile } from './artifacts.js';
import { sha256Hex } from './contracts.js';

export const SUPPORTED_ARCHIVE_SCHEMA_VERSIONS = Object.freeze([EXPECTED_SCHEMA_VERSION]);
export const SUPPORTED_CHILDHOOD_VERSIONS = Object.freeze([CHILDHOOD_VERSION]);
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const MAX_SANE_OPEN_SEC = 1e11; // an open timestamp at or above this is milliseconds, not seconds: refused as unit confusion

// validate ONE candle series row of the 1m track; returns the bounded in-memory series
export function validateCandleSeriesRow(row, { intervalMin, limits = LIMITS, file = 'candles' } = {}) {
  if (!isPlainObject(row)) fail('CORRUPT_INPUT', `${file}: series row is not an object`);
  if (typeof row.symbol !== 'string' || !COIN_RE.test(row.symbol)) fail('CORRUPT_INPUT', `${file}: series symbol malformed`);
  if (row.intervalMin !== intervalMin) fail('CORRUPT_INPUT', `${file}: ${row.symbol} intervalMin ${String(row.intervalMin)} disagrees with the track`);
  if (!Number.isSafeInteger(row.retrievedSec) || row.retrievedSec <= 0 || row.retrievedSec >= MAX_SANE_OPEN_SEC) fail('CORRUPT_INPUT', `${file}: ${row.symbol} retrievedSec missing or not epoch seconds`);
  const retrievedTsMs = parseUtcInstant(row.retrievedTs);
  if (retrievedTsMs === null || retrievedTsMs !== row.retrievedSec * 1000) fail('CORRUPT_INPUT', `${file}: ${row.symbol} retrievedTs disagrees with retrievedSec`);
  if (!Array.isArray(row.candles)) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candles malformed`);
  if (row.candles.length > limits.maxCandlesPerSeries) fail('RESOURCE_LIMIT_EXCEEDED', `${file}: ${row.symbol} exceeds ${limits.maxCandlesPerSeries} candles`);
  const step = intervalMin * 60; let prev = null;
  for (let i = 0; i < row.candles.length; i += 1) {
    const c = row.candles[i];
    if (!Array.isArray(c) || c.length !== 6 || c.some((x) => !isFiniteNum(x))) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} is not six finite numbers`);
    const [open, o, h, l, cl, v] = c;
    if (!Number.isSafeInteger(open) || open <= 0) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} open timestamp malformed`);
    if (open >= MAX_SANE_OPEN_SEC) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} open timestamp looks like milliseconds (seconds required)`);
    if (open % step !== 0) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} is not aligned to the ${intervalMin}m grid`);
    if (prev !== null && open <= prev) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} is ${open === prev ? 'a duplicate' : 'out of order'}`);
    if (o <= 0 || h <= 0 || l <= 0 || cl <= 0) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} carries a non-positive price`);
    if (h < Math.max(o, cl) || l > Math.min(o, cl) || l > h) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} has impossible OHLC`);
    if (v < 0) fail('CORRUPT_INPUT', `${file}: ${row.symbol} candle ${i} has negative volume`);
    if (open + step > row.retrievedSec) fail('CORRUPT_INPUT', `${file}: ${row.symbol} contains a candle not closed by retrieval time`);
    prev = open;
  }
  const index = new Map(); row.candles.forEach((c, i) => index.set(c[0], i));
  return { symbol: row.symbol, intervalSec: step, retrievedSec: row.retrievedSec, retrievedTsMs, coverageEndSec: row.retrievedSec, candles: row.candles, index, count: row.candles.length, firstOpenSec: row.candles.length ? row.candles[0][0] : null, lastOpenSec: row.candles.length ? row.candles[row.candles.length - 1][0] : null };
}

export function readChildhoodArchive(dir, { limits = LIMITS } = {}) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) fail('INVALID_REQUEST', 'the Childhood archive directory does not exist');
  const consumedFiles = {};
  const mf = readJsonFile(path.join(dir, 'manifest.json'), { limits }); const m = mf.value; consumedFiles['manifest.json'] = { sha256: mf.sha256, bytes: mf.bytes, declaredSha256_16: null };
  if (!isPlainObject(m)) fail('CORRUPT_INPUT', 'manifest.json is not an object');
  if (!SUPPORTED_ARCHIVE_SCHEMA_VERSIONS.includes(m.schemaVersion) || !SUPPORTED_CHILDHOOD_VERSIONS.includes(m.childhoodVersion)) fail('UNSUPPORTED_INPUT_VERSION', `archive schemaVersion ${String(m.schemaVersion).slice(0, 60)} / childhoodVersion ${String(m.childhoodVersion).slice(0, 40)} is not supported`);
  const archiveCreatedTsMs = parseUtcInstant(m.archiveCreatedTs);
  const declared = isPlainObject(m.sourceChecksumsSha256_16) ? m.sourceChecksumsSha256_16 : null;
  if (declared === null) fail('CORRUPT_INPUT', 'manifest.json declares no sourceChecksumsSha256_16');
  const tracks = {}; let oneMinute = null;
  for (const [name, decl] of Object.entries(declared)) {
    const mt = /^candles-(\d+)m\.jsonl$/.exec(name); if (!mt) fail('CORRUPT_INPUT', `manifest declares an unexpected source file ${name.slice(0, 60)}`);
    const intervalMin = Number(mt[1]); const file = path.join(dir, name); const present = existsSync(file);
    if (decl === null) { if (present) fail('CORRUPT_INPUT', `${name} exists but the manifest declares no checksum for it`); tracks[`${intervalMin}m`] = { declared: false, present: false, symbols: 0, candles: 0, fromSec: null, toSec: null, role: readPath(m, ['historicalSourceCoverage', `${intervalMin}m`, 'role']).value ?? null }; continue; }
    if (typeof decl !== 'string' || !/^[0-9a-f]{16}$/.test(decl)) fail('CORRUPT_INPUT', `${name}: declared checksum malformed`);
    if (!present) fail('CORRUPT_INPUT', `${name} is declared by the manifest but missing`);
    const buf = readBoundedFile(file, { limits }); const full = sha256Hex(buf);
    if (full.slice(0, 16) !== decl) fail('CORRUPT_INPUT', `${name}: bytes do not match the manifest checksum`);
    consumedFiles[name] = { sha256: full, bytes: buf.length, declaredSha256_16: decl };
    let symbols = 0; let candles = 0; let fromSec = null; let toSec = null; const seen = new Set(); const series = intervalMin === 1 ? new Map() : null;
    for (const row of readJsonlStrict(file, { limits })) {
      const s = validateCandleSeriesRow(row, { intervalMin, limits, file: name });
      if (seen.has(s.symbol)) fail('CORRUPT_INPUT', `${name}: ${s.symbol} appears twice (one series per symbol per track)`); seen.add(s.symbol);
      symbols += 1; candles += s.count;
      if (s.firstOpenSec !== null) { fromSec = fromSec === null ? s.firstOpenSec : Math.min(fromSec, s.firstOpenSec); toSec = toSec === null ? s.coverageEndSec : Math.max(toSec, s.coverageEndSec); }
      if (series) series.set(s.symbol, s); // only the raw 1m track is retained in memory (bounded per series); coarser tracks are counted, never retained
    }
    tracks[`${intervalMin}m`] = { declared: true, present: true, symbols, candles, fromSec, toSec, role: readPath(m, ['historicalSourceCoverage', `${intervalMin}m`, 'role']).value ?? null };
    if (series) oneMinute = series;
  }
  const countLines = (name) => { const f = path.join(dir, name); if (!existsSync(f)) return null; let n = 0; const buf = readBoundedFile(f, { limits }); consumedFiles[name] = { sha256: sha256Hex(buf), bytes: buf.length, declaredSha256_16: null }; for (const _ of readJsonlStrict(f, { limits })) n += 1; return n; };
  const observations = countLines('observations.jsonl'); const outcomes = countLines('outcomes.jsonl');
  const limitations = [];
  if (m.universeCoverageStatus === 'SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET') limitations.push('SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET');
  if (typeof m.fastMemoryParityStatus === 'string' && !/ACHIEVED|PASS|OK/.test(m.fastMemoryParityStatus)) limitations.push('FAST_MEMORY_PARITY_LIMITED');
  if (archiveCreatedTsMs === null) limitations.push('PROVENANCE_CLOCK_MISSING');
  if (!oneMinute || oneMinute.size === 0) limitations.push('NO_1M_TRACK');
  const census = deepFreeze({
    identity: { schemaVersion: m.schemaVersion, childhoodVersion: m.childhoodVersion, archiveCreatedTs: archiveCreatedTsMs === null ? null : new Date(archiveCreatedTsMs).toISOString(), archiveCreatedTsMs, codeCommit: typeof m.codeCommit === 'string' ? m.codeCommit.slice(0, 64) : null, manifestSha256: mf.sha256 },
    source: { historicalSourceType: typeof m.historicalSourceType === 'string' ? m.historicalSourceType.slice(0, 120) : null, sourceLatestTs: typeof m.sourceLatestTs === 'string' ? m.sourceLatestTs : null, universeCoverageStatus: typeof m.universeCoverageStatus === 'string' ? m.universeCoverageStatus.slice(0, 80) : null, fastMemoryParityStatus: typeof m.fastMemoryParityStatus === 'string' ? m.fastMemoryParityStatus.slice(0, 80) : null, universeToday: Number.isSafeInteger(m.universeToday) ? m.universeToday : null, deepUniverseCount: Array.isArray(m.deepUniverse) ? m.deepUniverse.length : null },
    tracks, oneMinuteSymbols: oneMinute ? [...oneMinute.keys()].sort() : [], observations, outcomes, consumedFiles, limitations,
  });
  return { census, oneMinute: oneMinute ?? new Map(), archiveCreatedTsMs, consumedFiles, limitations };
}
