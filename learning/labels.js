// LEARN-1 — the candle-only label recipe (learning-candle-labels-1) and the bounded archive reader.
//
// This MIRRORS the repository's predetermined offline label law WITHOUT importing the offline pipeline: the
// operational fence (test/social-5b-fences.test.js F2) keeps every offline research module out of operational
// reach, exactly as market-lab mirrors the Judge's experiment law without importing judge/. The semantics are the
// same, deliberately, so Serpent cannot learn under one definition and evaluate under another:
//   anchorTsMs = ceil(decisionKnownAtTs / 60000) * 60000; reference price = close of the 1m bar CLOSING at the
//   anchor; horizons 1/3/5/15/30/60/240 minutes over closed bars on the exact 60s grid; mfePct >= 0, maePct <= 0;
//   logReturnPct (LOG_RETURN_PERCENT) on 60m/240m; horizonEndTs = anchor + H*60000;
//   outcomeKnownAtTs = max(horizonEndTs, archiveCreatedTsMs, series.retrievedTsMs) — an archive acquired later
//   makes nothing learnable earlier. Missing bars are CENSORED (never zero return); a missing archive / track /
//   series / reference is OUTCOME_UNAVAILABLE under one reason for the whole row; a floor after the as-of is
//   NOT_YET_KNOWN with every value null. Nothing here resolves intrabar ordering, fees, fills or edge.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isTs, isFiniteNum, isCoin, round4, deepFreeze } from './contracts.js';

export const LEARNING_LABEL_RECIPE_VERSION = 'learning-candle-labels-1';
export const LABEL_HORIZONS_MIN = Object.freeze([1, 3, 5, 15, 30, 60, 240]);
export const LOG_RETURN_HORIZONS_MIN = Object.freeze([60, 240]);
export const SUPPORTED_ARCHIVE_SCHEMA_VERSIONS = Object.freeze(['childhood-observation-3-b0b']);
export const SUPPORTED_CHILDHOOD_VERSIONS = Object.freeze(['B0B.2A']);
const MAX_SANE_OPEN_SEC = 1e11; // seconds, never milliseconds
const MAX_CANDLES_PER_SERIES = 250_000;
const MAX_TRACK_BYTES = 512 * 1024 * 1024;

export const anchorOf = (decisionKnownAtTs) => { const anchorTsMs = Math.ceil(decisionKnownAtTs / 60_000) * 60_000; return { anchorTsMs, anchorLagMs: anchorTsMs - decisionKnownAtTs }; };

const hz = (state, reason, horizonEndTs, outcomeKnownAtTs, values = {}, logHorizon = false) => ({
  state, reason, horizonEndTs, outcomeKnownAtTs,
  mfePct: values.mfePct ?? null, maePct: values.maePct ?? null,
  logReturnPct: logHorizon ? (values.logReturnPct ?? null) : null, logReturnUnit: logHorizon ? 'LOG_RETURN_PERCENT' : null,
});

export function labelOpportunity({ rowId, canonicalCoin, decisionKnownAtTs }, { archive = null, asOfTs }) {
  if (typeof rowId !== 'string' || !isCoin(canonicalCoin) || !isTs(decisionKnownAtTs) || !isTs(asOfTs)) throw new Error('labelOpportunity: identity / clocks malformed');
  const { anchorTsMs, anchorLagMs } = anchorOf(decisionKnownAtTs);
  const base = { rowId, labelRecipeVersion: LEARNING_LABEL_RECIPE_VERSION, canonicalCoin, decisionKnownAtTs, anchorTsMs, anchorLagMs, sourceTrack: '1m' };
  const unavailable = (reason) => deepFreeze({ ...base, availability: { state: 'UNAVAILABLE', reason }, reference: { state: 'OUTCOME_UNAVAILABLE', barOpenSec: null, price: null, knownAtTs: null }, horizons: Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, hz('OUTCOME_UNAVAILABLE', reason, anchorTsMs + h * 60_000, null, {}, LOG_RETURN_HORIZONS_MIN.includes(h))])) });
  if (!archive) return unavailable('ARCHIVE_ABSENT');
  if (!isTs(archive.archiveCreatedTsMs)) return unavailable('PROVENANCE_CLOCK_MISSING');
  if (!(archive.oneMinute instanceof Map) || archive.oneMinute.size === 0) return unavailable('NO_1M_TRACK');
  const series = archive.oneMinute.get(canonicalCoin);
  if (!series) return unavailable('SERIES_ABSENT_FOR_ASSET');
  if (!isTs(series.retrievedTsMs)) return unavailable('PROVENANCE_CLOCK_MISSING');
  const anchorSec = anchorTsMs / 1000; const refOpenSec = anchorSec - 60;
  if (series.firstOpenSec === null || refOpenSec < series.firstOpenSec || refOpenSec > series.lastOpenSec) return unavailable('NO_TEMPORAL_OVERLAP');
  const refIdx = series.index.get(refOpenSec);
  if (refIdx === undefined) return unavailable('REFERENCE_BAR_MISSING');
  const referenceKnownAtTs = Math.max(anchorTsMs, archive.archiveCreatedTsMs, series.retrievedTsMs);
  const p = series.candles[refIdx][4];
  const horizons = {};
  for (const h of LABEL_HORIZONS_MIN) {
    const key = `${h}m`; const logH = LOG_RETURN_HORIZONS_MIN.includes(h);
    const horizonEndTs = anchorTsMs + h * 60_000;
    const outcomeKnownAtTs = Math.max(horizonEndTs, archive.archiveCreatedTsMs, series.retrievedTsMs);
    if (asOfTs < outcomeKnownAtTs) { horizons[key] = hz('NOT_YET_KNOWN', 'NOT_YET_KNOWN_AT_AS_OF', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    if (series.coverageEndSec < anchorSec + h * 60) { horizons[key] = hz('CENSORED', 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    const start = series.index.get(anchorSec);
    let complete = start !== undefined && start + h - 1 < series.count;
    if (complete) for (let k = 0; k < h; k += 1) if (series.candles[start + k][0] !== anchorSec + 60 * k) { complete = false; break; }
    if (!complete) { horizons[key] = hz('CENSORED', 'INTERIOR_BAR_MISSING', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    let hi = -Infinity; let lo = Infinity;
    for (let k = 0; k < h; k += 1) { const c = series.candles[start + k]; if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; }
    const finalClose = series.candles[start + h - 1][4];
    horizons[key] = hz('KNOWN', 'COMPLETE', horizonEndTs, outcomeKnownAtTs, {
      mfePct: round4(Math.max(0, (hi / p - 1) * 100)), maePct: round4(Math.min(0, (lo / p - 1) * 100)), logReturnPct: round4(100 * Math.log(finalClose / p)),
    }, logH);
  }
  const reference = asOfTs < referenceKnownAtTs
    ? { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: referenceKnownAtTs }
    : { state: 'KNOWN', barOpenSec: refOpenSec, price: p, knownAtTs: referenceKnownAtTs };
  const states = Object.values(horizons).map((x) => x.state);
  const availability = states.some((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN')
    ? { state: states.every((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN') ? 'AVAILABLE' : 'PARTIAL', reason: 'COMPLETE' }
    : { state: 'PARTIAL', reason: 'INTERIOR_BAR_MISSING' };
  return deepFreeze({ ...base, availability, reference, horizons });
}

// ---- the bounded archive reader (candle tracks only; observations/outcomes belong to the read-only Memory bridge)
export function validateCandleSeriesRow(row, { intervalMin = 1, file = 'candles' } = {}) {
  if (row === null || typeof row !== 'object') throw new Error(`${file}: series row is not an object`);
  if (!isCoin(row.symbol)) throw new Error(`${file}: series symbol is not a canonical asset identity`);
  if (row.intervalMin !== intervalMin) throw new Error(`${file}: series intervalMin disagrees with its track`);
  if (!Number.isSafeInteger(row.retrievedSec) || row.retrievedSec <= 0 || row.retrievedSec >= MAX_SANE_OPEN_SEC) throw new Error(`${file}: series retrievedSec malformed`);
  const retrievedTsMs = Date.parse(row.retrievedTs);
  if (!Number.isSafeInteger(retrievedTsMs) || retrievedTsMs !== row.retrievedSec * 1000) throw new Error(`${file}: series retrievedTs disagrees with retrievedSec`);
  if (!Array.isArray(row.candles) || row.candles.length > MAX_CANDLES_PER_SERIES) throw new Error(`${file}: series candle list malformed or over bound`);
  const step = intervalMin * 60; let prev = null;
  for (let i = 0; i < row.candles.length; i += 1) {
    const c = row.candles[i];
    if (!Array.isArray(c) || c.length !== 6 || c.some((x) => !isFiniteNum(x))) throw new Error(`${file}: candle ${i} is not six finite numbers`);
    const [open, o, h, l, cl, v] = c;
    if (!Number.isSafeInteger(open) || open <= 0 || open >= MAX_SANE_OPEN_SEC || open % step !== 0) throw new Error(`${file}: candle ${i} open malformed / off grid`);
    if (prev !== null && open <= prev) throw new Error(`${file}: candle ${i} duplicate or out of order`);
    if (o <= 0 || h <= 0 || l <= 0 || cl <= 0 || h < Math.max(o, cl) || l > Math.min(o, cl) || l > h || v < 0) throw new Error(`${file}: candle ${i} impossible OHLCV`);
    if (open + step > row.retrievedSec) throw new Error(`${file}: candle ${i} not closed by retrieval time`);
    prev = open;
  }
  const index = new Map(); row.candles.forEach((c, i) => index.set(c[0], i));
  return { symbol: row.symbol, intervalSec: step, retrievedSec: row.retrievedSec, retrievedTsMs, coverageEndSec: row.retrievedSec, candles: row.candles, index, count: row.candles.length, firstOpenSec: row.candles.length ? row.candles[0][0] : null, lastOpenSec: row.candles.length ? row.candles[row.candles.length - 1][0] : null };
}

export function readLearningArchive(dir) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('learning archive: directory does not exist');
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error('learning archive: manifest.json absent');
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!SUPPORTED_ARCHIVE_SCHEMA_VERSIONS.includes(m.schemaVersion) || !SUPPORTED_CHILDHOOD_VERSIONS.includes(m.childhoodVersion)) throw new Error('learning archive: unsupported schemaVersion / childhoodVersion');
  const archiveCreatedTsMs = typeof m.archiveCreatedTs === 'string' ? Date.parse(m.archiveCreatedTs) : null;
  if (m.archiveCreatedTs !== undefined && m.archiveCreatedTs !== null && !Number.isSafeInteger(archiveCreatedTsMs)) throw new Error('learning archive: archiveCreatedTs malformed');
  const declared = m.sourceChecksumsSha256_16;
  if (declared === null || typeof declared !== 'object') throw new Error('learning archive: no sourceChecksumsSha256_16');
  const decl = declared['candles-1m.jsonl'];
  const limitations = [];
  let oneMinute = new Map();
  if (typeof decl === 'string') {
    const file = path.join(dir, 'candles-1m.jsonl');
    if (!existsSync(file)) throw new Error('learning archive: declared 1m track missing');
    if (statSync(file).size > MAX_TRACK_BYTES) throw new Error('learning archive: 1m track exceeds the read bound');
    const body = readFileSync(file);
    const sha16 = createHash('sha256').update(body).digest('hex').slice(0, 16);
    if (sha16 !== decl) throw new Error('learning archive: 1m track bytes do not match the manifest checksum');
    for (const line of body.toString('utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      const s = validateCandleSeriesRow(JSON.parse(t), { intervalMin: 1, file: 'candles-1m.jsonl' });
      if (oneMinute.has(s.symbol)) throw new Error('learning archive: a series symbol appears twice');
      // an archive cannot have been created before a series it consumed was retrieved
      if (Number.isSafeInteger(archiveCreatedTsMs) && s.retrievedTsMs > archiveCreatedTsMs) throw new Error('learning archive: series retrieved after the declared archive creation');
      oneMinute.set(s.symbol, s);
    }
  }
  if (m.universeCoverageStatus === 'SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET') limitations.push('SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET');
  if (!Number.isSafeInteger(archiveCreatedTsMs)) limitations.push('PROVENANCE_CLOCK_MISSING');
  if (oneMinute.size === 0) limitations.push('NO_1M_TRACK');
  const manifestSha256 = createHash('sha256').update(readFileSync(manifestFile)).digest('hex');
  return {
    archiveCreatedTsMs: Number.isSafeInteger(archiveCreatedTsMs) ? archiveCreatedTsMs : null,
    oneMinute, limitations,
    census: { identity: { manifestSha256, schemaVersion: m.schemaVersion, childhoodVersion: m.childhoodVersion } },
  };
}
