// FORWARD-SHADOW LANE — the deterministic market-capture-to-shadow adapter. It consumes the market-lab owner's
// SEALED capture bundles (manifest-last, per-member sha256) and normalized observations WITHOUT importing any
// market-lab module: the learning fence forbids the import, so this file MIRRORS the byte formats it reads
// (manifest.json member descriptors + market-observation-1 rows) and verifies integrity itself — the same
// mirror-without-import pattern learning/labels.js uses for the childhood archive.
//
// Laws:
//   - INTEGRITY FIRST: the observations member's bytes must hash to the manifest's sha256 and match its byte
//     count; a truncated/partial or altered member refuses the WHOLE bundle with the reason. No partial trust.
//   - NO INVENTED CLOCKS: every candle's knownAtTs is the observation's own receipt-derived knownAtTs; the
//     decision clock of an opportunity is the LATEST knownAtTs of its frozen window (the actual moment the
//     then-known world was complete) — never "now", never a caller guess.
//   - NO ZERO-FILL: a FINAL candle without real volume stays without volume (the capture law downgrades that
//     to INELIGIBLE VOLUME_MISSING); trade-flow exists only where TRADE observations were actually received;
//     depth exists only where a BOOK_SNAPSHOT was actually received. Absence is absence.
//   - NO FUTURE AS INPUT: only FINAL, closed, non-provisional candles whose periodEnd AND knownAt precede the
//     decision clock enter a decision window; maturation paths carry only observations known AFTER the capture.
//   - DETERMINISM: identical bundle bytes + identical recipe => identical opportunities, byte for byte.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readJsonBounded } from '../lib/jsonl.js';
import { deepFreeze, isPlainObject, isTs, isFiniteNum } from './shadow-contracts.js';

export const ADAPTER_VERSION = 'shadow-market-adapter-1';
export const MIRRORED_OBSERVATION_SCHEMA = 'market-observation-1'; // the market-lab wire format this mirror reads
export const MIRRORED_BUNDLE_KIND = 'CAPTURE';
const MINUTE = 60_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVATIONS_BYTES = 256 * 1024 * 1024;

// ---- sealed-bundle mirror reader ------------------------------------------------------------------------------
// Returns { ok: true, rows, bundleId, observationCount } or { ok: false, refused, detail } — never a partial row set.
export function readSealedMarketCapture(dir) {
  const refuse = (refused, detail) => deepFreeze({ ok: false, refused, detail: String(detail).slice(0, 300) });
  if (typeof dir !== 'string' || !dir.length) return refuse('BUNDLE_UNREADABLE', 'a bundle directory is required');
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) return refuse('MANIFEST_MISSING', manifestFile);
  let manifest;
  try { manifest = readJsonBounded(manifestFile, MAX_MANIFEST_BYTES); } catch (err) { return refuse('MANIFEST_UNREADABLE', err.message); }
  if (!isPlainObject(manifest) || manifest.bundleKind !== MIRRORED_BUNDLE_KIND || !Array.isArray(manifest.members)) return refuse('NOT_A_SEALED_CAPTURE_BUNDLE', `kind=${manifest?.bundleKind}`);
  const member = manifest.members.find((m) => m?.name === 'observations.jsonl');
  if (!member || !/^[0-9a-f]{64}$/.test(String(member.sha256)) || !Number.isSafeInteger(member.bytes)) return refuse('OBSERVATIONS_MEMBER_MISSING', 'the manifest names no verifiable observations member');
  const file = path.join(dir, 'observations.jsonl');
  if (!existsSync(file)) return refuse('OBSERVATIONS_MEMBER_MISSING', file);
  const size = statSync(file).size;
  if (size > MAX_OBSERVATIONS_BYTES) return refuse('BUNDLE_UNREADABLE', `observations member exceeds the adapter bound (${size} bytes)`);
  const bytes = readFileSync(file);
  // a PARTIAL or altered member is a refused bundle, with which check failed named — never a silently shorter read
  if (bytes.length !== member.bytes) return refuse('OBSERVATIONS_TRUNCATED_OR_EXTENDED', `${bytes.length} bytes on disk vs ${member.bytes} sealed`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== member.sha256) return refuse('OBSERVATIONS_DIGEST_MISMATCH', `sha256 ${digest.slice(0, 12)}… vs sealed ${String(member.sha256).slice(0, 12)}…`);
  const rows = [];
  const text = bytes.toString('utf8');
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return refuse('OBSERVATION_ROW_MALFORMED', `line ${lineNo} is not JSON`); }
    if (!isPlainObject(row) || row.schemaVersion !== MIRRORED_OBSERVATION_SCHEMA) return refuse('OBSERVATION_ROW_MALFORMED', `line ${lineNo}: schema ${row?.schemaVersion}`);
    rows.push(row);
  }
  if (Number.isSafeInteger(member.lines) && member.lines !== rows.length + 0 && member.lines !== lineNo - (text.endsWith('\n') ? 1 : 0)) {
    // the manifest's own line count disagrees with what the bytes parse to — refuse rather than guess
    if (member.lines !== rows.length) return refuse('OBSERVATIONS_TRUNCATED_OR_EXTENDED', `${rows.length} rows vs ${member.lines} sealed lines`);
  }
  return deepFreeze({ ok: true, bundleId: manifest.bundleId ?? null, rows, observationCount: rows.length });
}

// ---- normalization: observation rows -> lane candles / trade-flow / depth for ONE market -----------------------
const marketMatches = (row, { venue, canonicalCoin }) => isPlainObject(row.subject)
  && row.subject.subjectKind === 'MARKET' && row.subject.canonicalCoin === canonicalCoin && row.subject.venue === venue;

// a candle usable as decision input: FINAL, closed, non-provisional, real prices, ONE-minute period, with its
// own receipt-derived knownAt. Volume is passed through EXACTLY as observed (null stays null — the capture law
// judges it); trade-flow is attached only from actually received TRADE rows fully inside the candle period.
export function normalizeMarketRows(rows, { venue, canonicalCoin }) {
  const candles = []; const trades = []; const depths = [];
  for (const row of rows) {
    if (!marketMatches(row, { venue, canonicalCoin })) continue;
    if (!isTs(row.knownAtTs) || !isTs(row.receivedTs) || row.knownAtTs < row.receivedTs) continue; // a clockless row is not evidence
    if (row.kind === 'CANDLE') {
      const p = row.payload;
      if (!isPlainObject(p) || p.closed !== true || p.provisional === true) continue;
      if (row.quality?.state !== 'FINAL') continue;
      if (!isTs(row.periodStartTs) || !isTs(row.periodEndTs) || row.periodEndTs - row.periodStartTs !== MINUTE) continue;
      if (![p.open, p.high, p.low, p.close].every((v) => isFiniteNum(v) && v > 0)) continue; // a no-trade candle (null prices) is not a decision candle
      candles.push({
        periodStartTs: row.periodStartTs, periodEndTs: row.periodEndTs,
        open: p.open, high: p.high, low: p.low, close: p.close,
        volumeBase: isFiniteNum(p.volumeBase) ? p.volumeBase : undefined, // ABSENT stays absent — never zero
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
      depths.push({ bids: p.bids, asks: p.asks, knownAtTs: row.knownAtTs });
    }
  }
  candles.sort((a, b) => a.periodStartTs - b.periodStartTs || a.knownAtTs - b.knownAtTs);
  // one candle per period: keep the EARLIEST-known FINAL version (a later revision never rewrites known history)
  const byPeriod = new Map();
  for (const c of candles) if (!byPeriod.has(c.periodStartTs)) byPeriod.set(c.periodStartTs, c);
  const uniq = [...byPeriod.values()];
  // trade-flow per candle, from trades actually received and attributable to the period; NO trades => undefined
  for (const c of uniq) {
    const inPeriod = trades.filter((t) => isTs(t.ts) && t.ts >= c.periodStartTs && t.ts < c.periodEndTs);
    if (inPeriod.length) {
      const gross = inPeriod.reduce((a, t) => a + t.qty, 0);
      const net = inPeriod.reduce((a, t) => a + t.signedQty, 0);
      c.tradeFlow = gross > 0 ? Math.round((net / gross) * 1e6) / 1e6 : undefined;
      // a trade received later than the candle can only be KNOWN later: the candle's flow becomes known when
      // its last contributing trade did — the knownAt clock never runs backwards
      c.knownAtTs = Math.max(c.knownAtTs, ...inPeriod.map((t) => t.knownAtTs));
    }
  }
  depths.sort((a, b) => a.knownAtTs - b.knownAtTs);
  return deepFreeze({ candles: uniq, depths, tradeCount: trades.length });
}

// ---- deterministic opportunity extraction ----------------------------------------------------------------------
// For every candle index that completes a recipe window, build ONE opportunity whose decision clock is the
// LATEST knownAt of the frozen window (the actual receipt moment the then-known world completed). Optional
// afterDecisionTs excludes already-consumed opportunities (the restart cursor); maxOpportunities bounds work.
export function extractShadowOpportunities({ normalized, recipe, venue, canonicalCoin, afterDecisionTs = null, maxOpportunities = 1000 }) {
  const w = recipe.candleWindowMin;
  const out = [];
  const { candles, depths } = normalized;
  for (let i = w - 1; i < candles.length && out.length < maxOpportunities; i += 1) {
    const window = candles.slice(i - w + 1, i + 1);
    let contiguous = true;
    for (let j = 1; j < window.length; j += 1) if (window[j].periodStartTs !== window[j - 1].periodEndTs) { contiguous = false; break; }
    if (!contiguous) continue; // a gapped window is simply not an opportunity here; the capture law would refuse it anyway
    const decisionTs = Math.max(...window.map((c) => c.knownAtTs));
    if (afterDecisionTs !== null && decisionTs <= afterDecisionTs) continue; // the cursor: already-consumed history is never re-presented as fresh
    if (decisionTs - window[window.length - 1].periodEndTs > recipe.maxInputAgeMs) continue; // received too late to have been a live decision
    const depth = [...depths].reverse().find((d) => d.knownAtTs <= decisionTs && decisionTs - d.knownAtTs <= recipe.maxInputAgeMs) ?? null;
    out.push(deepFreeze({ venue, assetId: canonicalCoin, decisionTs, inputs: { candles: window, ...(depth ? { depth } : {}) } }));
  }
  return deepFreeze(out);
}

// ---- maturation paths from LATER actually received observations ------------------------------------------------
// For each capture, the path is the FINAL candles that STARTED at/after its decision boundary and became KNOWN
// strictly after its decision clock and at/before asOf. A capture with no such candles gets no path entry
// (PENDING / UNMATURABLE is the outcome law's judgement, never fabricated candles).
export function extractMaturationPaths({ normalized, captures, asOfTs }) {
  const paths = {};
  for (const capture of captures) {
    const bound = Math.ceil(capture.decisionTs / MINUTE) * MINUTE;
    const pathCandles = normalized.candles.filter((c) => c.periodStartTs >= bound && c.knownAtTs > capture.decisionTs && c.knownAtTs <= asOfTs);
    if (pathCandles.length) paths[capture.captureId] = { candles: pathCandles };
  }
  return deepFreeze(paths);
}
