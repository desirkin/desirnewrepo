// BROAD-KRAKEN 1-MINUTE SERIES SOURCE (Ticket 3 step 3, 2026-09-15). The decision-outcome recorder needs a 1-minute
// closed-candle series around each decision to score the 5m bite and 15m continuation. The broad-Kraken collector
// already captures conservative-closed 1m OHLC for the whole accepted USD catalog (both runtime modes) into rolling
// JSONL segments under <dataDir>/broad-kraken/. This adapter reads the most recent bounded segments, collects the
// CONSERVATIVE_CLOSED candles for a coin, and shapes them into the exact series learning/labels.js and the yardstick
// expect. Read-only, bounded, dormant: it grants no authority and never writes.
//
// A ~15-minute lookback is well inside the collector's rolling retention, so the reference bar through the continuation
// horizon are present whenever the collector was live. When they are not (collector off, coin not in the catalog, or
// the window evicted) the series is absent for that coin and the yardstick records an honest OUTCOME_UNAVAILABLE.
import path from 'node:path';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export const BROAD_KRAKEN_SERIES_VERSION = 'broad-kraken-series-1';
const SEGMENT_RE = /^events-(\d{6})\.jsonl$/;
const DEFAULT_MAX_SEGMENTS = 3;                 // ~3 x 16 MiB rolling segments cover well over an hour of the full catalog
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;     // hard read bound across the scanned segments
const DEFAULT_TTL_MS = 30_000;                  // rebuild the coin index at most this often; a recorder tick reuses it
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);

// PUBLISH-FIX-53 (2026-09-17): the index is INCREMENTAL. The first build read up to 3 x 16 MiB of JSONL and JSON-parsed
// every line, and the 30 s TTL repeated that on the main thread all day (production CPU profiles: readFileUtf8 +
// buildIndex among the top frames; LOOP: hundreds of >100 ms stalls per 15 min, which is what inflated every serialized
// journal commit and cancelled scheduler jobs). Now each segment is read from the byte where the last read stopped, a
// torn trailing line waits for its rest, bars are kept per (coin, minute) with last-write-wins as before, bars older than
// the retention are evicted, and the finalized series shape is rebuilt only when something changed. Same records,
// same shape, same laws; a refresh after the first costs milliseconds.
const RETENTION_SEC = 6 * 3600;
function parseLine(t, coins) {
  let r; try { r = JSON.parse(t); } catch { return; }
  if (r.recordType !== 'OHLC' || r.quality !== 'CONSERVATIVE_CLOSED' || !r.market || typeof r.market.canonicalCoin !== 'string') return;
  const p = r.payload; if (!p || !Number.isSafeInteger(r.periodStartTs) || !Number.isSafeInteger(r.periodEndTs) || r.periodEndTs - r.periodStartTs !== 60_000) return;
  const nums = [p.open, p.high, p.low, p.close];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return;
  const openSec = r.periodStartTs / 1000; if (!Number.isInteger(openSec) || openSec % 60 !== 0) return;
  const coin = r.market.canonicalCoin;
  let c = coins.get(coin); if (!c) { c = { bars: new Map(), trades: new Map(), maxReceivedTs: 0 }; coins.set(coin, c); }
  c.bars.set(openSec, [openSec, p.open, p.high, p.low, p.close, typeof p.volumeBase === 'number' && Number.isFinite(p.volumeBase) ? p.volumeBase : 0]); c.trades.set(openSec, Number.isSafeInteger(p.trades) && p.trades >= 0 ? p.trades : null); // PUBLISH-FIX-83 item 14: the minute's print count beside the candle (the candle itself stays six numbers: labels.js validates that shape)
  if (Number.isSafeInteger(r.receivedTs) && r.receivedTs > c.maxReceivedTs) c.maxReceivedTs = r.receivedTs;
}
export function createIncrementalIndex({ dir, maxSegments, maxBytes, log, retentionSec = RETENTION_SEC }) {
  const coins = new Map(); const segments = new Map(); // name -> { offset, rest }
  let out = new Map(); let dirty = true; let bytesTotal = 0;
  const stats = { refreshes: 0, fullReads: 0, deltaReads: 0, bytesRead: 0, linesParsed: 0, lastRefreshMs: 0 };
  function readDelta(file, seg, size) {
    const want = size - seg.offset; if (want <= 0) return 0;
    const buf = Buffer.allocUnsafe(want); let fd = null; let got = 0;
    try { fd = openSync(file, 'r'); got = readSync(fd, buf, 0, want, seg.offset); } finally { if (fd !== null) closeSync(fd); }
    if (got <= 0) return 0;
    seg.offset += got; stats.bytesRead += got;
    const text = seg.rest + buf.toString('utf8', 0, got); const lines = text.split('\n'); seg.rest = lines.pop() ?? '';
    for (const line of lines) { const t = line.trim(); if (!t) continue; stats.linesParsed += 1; parseLine(t, coins); }
    return got;
  }
  function refresh() {
    const t0 = Date.now(); stats.refreshes += 1;
    if (!existsSync(dir)) return out;
    let names;
    try { names = readdirSync(dir).map((n) => n.match(SEGMENT_RE)).filter(Boolean).map((m) => ({ name: m[0], index: Number(m[1]) })).sort((a, b) => b.index - a.index).slice(0, maxSegments); }
    catch (error) { log(`broad-kraken series: segment list failed: ${bounded(error?.message ?? error)}`); return out; }
    const inWindow = new Set(names.map((n) => n.name));
    for (const name of [...segments.keys()]) if (!inWindow.has(name)) { bytesTotal -= segments.get(name)?.counted ?? 0; segments.delete(name); } // a rolled segment: its bars stay until retention evicts them; PUBLISH-FIX-84: its bytes leave the budget with it (they never did — after ~1-2 weeks of rotations the budget was spent on segments long gone and every new segment but one per rotation was skipped: the watch read "stale" for every coin, outcomes OUTCOME_UNAVAILABLE, no log line)
    let changed = false;
    for (const { name } of [...names].reverse()) {
      const file = path.join(dir, name);
      let size; try { size = statSync(file).size; } catch { continue; }
      let seg = segments.get(name);
      if (!seg) { if (bytesTotal + size > maxBytes && segments.size) { stats.skippedOverBudget = (stats.skippedOverBudget ?? 0) + 1; if ((stats.skippedOverBudget % 50) === 1) log(`broad-kraken series: segment ${name} skipped — index budget ${Math.round(bytesTotal / 1048576)} of ${Math.round(maxBytes / 1048576)} MB in use across ${segments.size} segment(s)`); continue; } seg = { offset: 0, rest: '', counted: size }; segments.set(name, seg); stats.fullReads += 1; bytesTotal += size; } else if (size > seg.offset) { stats.deltaReads += 1; } else continue;
      try { if (readDelta(file, seg, size) > 0) changed = true; } catch (error) { log(`broad-kraken series: read failed ${name}: ${bounded(error?.message ?? error)}`); }
    }
    if (changed || dirty) {
      let newest = 0; for (const c of coins.values()) for (const k of c.bars.keys()) if (k > newest) newest = k;
      const floor = newest - retentionSec;
      const next = new Map();
      for (const [coin, c] of coins) {
        for (const k of [...c.bars.keys()]) if (k < floor) { c.bars.delete(k); c.trades.delete(k); } // the print counts age out with their candles (review finding: this Map used to grow forever)
        if (!c.bars.size || !c.maxReceivedTs) continue;
        // review finding (PUBLISH-FIX-83 items 17 / 22): the collector closes a candle only when the coin's NEXT interval arrives, so a minute
        // without a trade is a hole that made every yardstick CENSORED (INTERIOR_BAR_MISSING) on exactly the thin coins the Judge looks at.
        // A hole of at most FILL_GAP_MIN minutes is forward-filled (last close, no volume, no prints) — the series shape labels.js validates
        const sorted = [...c.bars.values()].sort((a, b) => a[0] - b[0]); const candles = [];
        for (const cd of sorted) { const prev = candles[candles.length - 1]; if (prev && cd[0] > prev[0] + 60 && (cd[0] - prev[0]) / 60 - 1 <= FILL_GAP_MIN) { for (let sec = prev[0] + 60; sec < cd[0]; sec += 60) candles.push([sec, prev[4], prev[4], prev[4], prev[4], 0]); } candles.push(cd); }
        const index = new Map(candles.map((cd, i) => [cd[0], i]));
        const lastOpenSec = candles[candles.length - 1][0];
        next.set(coin, { symbol: coin, intervalSec: 60, retrievedTsMs: c.maxReceivedTs, coverageEndSec: lastOpenSec + 60, candles, trades: candles.map((cd) => c.trades.get(cd[0]) ?? null), filled: candles.length - sorted.length, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec });
      }
      out = next; dirty = false;
    }
    stats.lastRefreshMs = Date.now() - t0;
    return out;
  }
  return { refresh, stats: () => ({ ...stats, segments: segments.size, coins: out.size }) };
}
// the one-shot builder is kept for callers that want a fresh read (tests, tools); the runtime source is incremental
export function buildIndex({ dir, maxSegments = DEFAULT_MAX_SEGMENTS, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) { return createIncrementalIndex({ dir, maxSegments, maxBytes, log }).refresh(); }

// Returns a source function (canonicalCoin, { asOfTs }) => series|null, with a bounded, TTL-cached index rebuild so one
// recorder tick over several decisions reads the segments at most once.
export const FILL_GAP_MIN = 5;
export function createBroadKrakenSeriesSource({ dataDir, log = () => {}, maxSegments = DEFAULT_MAX_SEGMENTS, maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('createBroadKrakenSeriesSource: dataDir required');
  const dir = path.join(path.resolve(dataDir), 'broad-kraken');
  const inc = createIncrementalIndex({ dir, maxSegments, maxBytes, log }); let index = null; let builtAt = 0;
  const refresh = () => { const t = now(); if (index && t - builtAt < ttlMs) return index; index = inc.refresh(); builtAt = t; return index; };
  const source = (canonicalCoin) => { const idx = refresh(); return idx.get(canonicalCoin) ?? null; };
  source.version = BROAD_KRAKEN_SERIES_VERSION;
  source.coins = () => [...refresh().keys()].sort();
  source.stats = () => inc.stats();
  return source;
}
