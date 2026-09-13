// LEARN-1 test helpers — synthetic candle series / archives (marked FIXTURE; synthetic evidence never counts as
// live success) shaped exactly like learning/labels.js readLearningArchive output.
export function makeSeries(symbol, startSec, bars, { drift = () => 0, volume = () => 10, gapAt = new Set(), coverageEndSec = null } = {}) {
  const candles = []; let p = 100;
  for (let i = 0; i < bars; i += 1) {
    if (gapAt.has(i)) continue; // a genuinely missing bar, never zero-filled
    const open = startSec + i * 60;
    const d = drift(i);
    const o = p; const c = p * (1 + d / 100); const h = Math.max(o, c) * 1.0005; const l = Math.min(o, c) * 0.9995;
    candles.push([open, o, h, l, c, volume(i)]);
    p = c;
  }
  const index = new Map(); candles.forEach((c, i) => index.set(c[0], i));
  const retrievedSec = coverageEndSec ?? startSec + bars * 60 + 3600;
  return {
    symbol, intervalSec: 60, retrievedSec, retrievedTsMs: retrievedSec * 1000, coverageEndSec: retrievedSec,
    candles, index, count: candles.length,
    firstOpenSec: candles.length ? candles[0][0] : null, lastOpenSec: candles.length ? candles[candles.length - 1][0] : null,
  };
}

export function makeArchive(seriesList, { createdAfterSec = 7200 } = {}) {
  const lastRetrieved = Math.max(...seriesList.map((s) => s.retrievedSec));
  return {
    archiveCreatedTsMs: (lastRetrieved + createdAfterSec) * 1000,
    oneMinute: new Map(seriesList.map((s) => [s.symbol, s])),
    limitations: [],
    census: { identity: { manifestSha256: 'f'.repeat(64) } },
  };
}

export const START_SEC = Math.floor(Date.UTC(2026, 5, 1) / 1000);
export const DAY_BARS = 1440;

// a rally around bar r: strong up-drift with a volume burst (trigger-shaped), then flat
export const rallyDrift = (r, width = 5, magnitude = 1.5) => (i) => (i >= r && i < r + width ? magnitude : 0.001 * Math.sin(i / 17));
export const burstVolume = (r, width = 5) => (i) => (i >= r && i < r + width ? 800 : 10);
