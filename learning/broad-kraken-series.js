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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

export const BROAD_KRAKEN_SERIES_VERSION = 'broad-kraken-series-1';
const SEGMENT_RE = /^events-(\d{6})\.jsonl$/;
const DEFAULT_MAX_SEGMENTS = 3;                 // ~3 x 16 MiB rolling segments cover well over an hour of the full catalog
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;     // hard read bound across the scanned segments
const DEFAULT_TTL_MS = 30_000;                  // rebuild the coin index at most this often; a recorder tick reuses it
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);

// Build a Map<coin, { candles, index, count, firstOpenSec, lastOpenSec, coverageEndSec, retrievedTsMs }> from the most
// recent segments. Only CONSERVATIVE_CLOSED 1m OHLC records are kept; a torn line is skipped. Newest write of a given
// (coin, minute) wins (the collector re-emits nothing, but a segment boundary can duplicate; last-seen is authoritative).
function buildIndex({ dir, maxSegments, maxBytes, log }) {
  const coins = new Map();
  if (!existsSync(dir)) return coins;
  let names;
  try { names = readdirSync(dir).map((n) => n.match(SEGMENT_RE)).filter(Boolean).map((m) => ({ name: m[0], index: Number(m[1]) })).sort((a, b) => b.index - a.index).slice(0, maxSegments); }
  catch (error) { log(`broad-kraken series: segment list failed: ${bounded(error?.message ?? error)}`); return coins; }
  let bytesRead = 0;
  // scan newest-first but keep the LAST write per (coin, minute): read oldest-of-the-window first so newer overwrites
  for (const { name } of [...names].reverse()) {
    const file = path.join(dir, name);
    let size; try { size = statSync(file).size; } catch { continue; }
    if (bytesRead + size > maxBytes) continue;
    bytesRead += size;
    let text; try { text = readFileSync(file, 'utf8'); } catch (error) { log(`broad-kraken series: read failed ${name}: ${bounded(error?.message ?? error)}`); continue; }
    for (const line of text.split('\n')) {
      const t = line.trim(); if (!t) continue;
      let r; try { r = JSON.parse(t); } catch { continue; }
      if (r.recordType !== 'OHLC' || r.quality !== 'CONSERVATIVE_CLOSED' || !r.market || typeof r.market.canonicalCoin !== 'string') continue;
      const p = r.payload; if (!p || !Number.isSafeInteger(r.periodStartTs) || !Number.isSafeInteger(r.periodEndTs) || r.periodEndTs - r.periodStartTs !== 60_000) continue;
      const nums = [p.open, p.high, p.low, p.close];
      if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) continue;
      const openSec = r.periodStartTs / 1000; if (!Number.isInteger(openSec) || openSec % 60 !== 0) continue;
      const coin = r.market.canonicalCoin;
      let c = coins.get(coin); if (!c) { c = { bars: new Map(), maxReceivedTs: 0 }; coins.set(coin, c); }
      c.bars.set(openSec, [openSec, p.open, p.high, p.low, p.close, typeof p.volumeBase === 'number' && Number.isFinite(p.volumeBase) ? p.volumeBase : 0]);
      if (Number.isSafeInteger(r.receivedTs) && r.receivedTs > c.maxReceivedTs) c.maxReceivedTs = r.receivedTs;
    }
  }
  // finalize each coin into the label-series shape
  const out = new Map();
  for (const [coin, c] of coins) {
    if (!c.bars.size || !c.maxReceivedTs) continue;
    const candles = [...c.bars.values()].sort((a, b) => a[0] - b[0]);
    const index = new Map(candles.map((cd, i) => [cd[0], i]));
    const lastOpenSec = candles[candles.length - 1][0];
    out.set(coin, { symbol: coin, intervalSec: 60, retrievedTsMs: c.maxReceivedTs, coverageEndSec: lastOpenSec + 60, candles, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec });
  }
  return out;
}

// Returns a source function (canonicalCoin, { asOfTs }) => series|null, with a bounded, TTL-cached index rebuild so one
// recorder tick over several decisions reads the segments at most once.
export function createBroadKrakenSeriesSource({ dataDir, log = () => {}, maxSegments = DEFAULT_MAX_SEGMENTS, maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('createBroadKrakenSeriesSource: dataDir required');
  const dir = path.join(path.resolve(dataDir), 'broad-kraken');
  let index = null; let builtAt = 0;
  const refresh = () => { const t = now(); if (index && t - builtAt < ttlMs) return index; index = buildIndex({ dir, maxSegments, maxBytes, log }); builtAt = t; return index; };
  const source = (canonicalCoin) => { const idx = refresh(); return idx.get(canonicalCoin) ?? null; };
  source.version = BROAD_KRAKEN_SERIES_VERSION;
  source.coins = () => [...refresh().keys()].sort();
  return source;
}
