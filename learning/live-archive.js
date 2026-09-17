// LIVE LEARNING ARCHIVE (PUBLISH-FIX-38, 2026-09-17). LEARN-1's maturation labels an episode against an "archive"
// — { archiveCreatedTsMs, oneMinute: Map<coin, series> } (learning/labels.js readLearningArchive's shape). Production
// never had the promoted Childhood archive under <dataDir>/childhood, so every maturation tick since launch reported
// ARCHIVE_UNAVAILABLE: 12,255 episodes captured, ZERO outcomes attached, ZERO pattern updates. The decision-outcome
// recorder, meanwhile, scores every Judge decision from the broad-Kraken 1-minute capture (learning/broad-kraken-
// series.js), whose per-coin series ARE the exact shape labels.js reads. This adapter presents that rolling capture as
// a live archive: the same labels, the same censoring vocabulary, the same knowledge floors — an episode whose window
// the rolling capture no longer covers is CENSORED / NO_TEMPORAL_OVERLAP, honestly, never invented.
//
// archiveCreatedTsMs is the clock at which this archive came into being (boot), fixed for the process: labels.js folds
// it into outcomeKnownAtTs, so a fixed early value never claims an outcome was known before the capture existed and
// never pushes every outcome's knowledge time to "now". Read-only; authority NONE.
export const LIVE_ARCHIVE_VERSION = 'learning-live-archive-1';

export function createLiveArchiveSource({ seriesSource, createdTs, maxCoins = 2_000 } = {}) {
  if (typeof seriesSource !== 'function' || typeof seriesSource.coins !== 'function') throw new Error('createLiveArchiveSource: a broad-Kraken series source (with coins()) is required');
  if (!Number.isSafeInteger(createdTs) || createdTs <= 0) throw new Error('createLiveArchiveSource: createdTs required');
  return () => {
    let coins;
    try { coins = seriesSource.coins(); } catch { return null; }
    if (!Array.isArray(coins) || coins.length === 0) return null; // no capture yet: honest ARCHIVE_UNAVAILABLE, exactly as before
    const oneMinute = new Map();
    for (const coin of coins.slice(0, maxCoins)) {
      let series = null;
      try { series = seriesSource(coin); } catch { series = null; }
      if (series && Array.isArray(series.candles) && series.candles.length > 0) oneMinute.set(coin, series);
    }
    if (oneMinute.size === 0) return null;
    return Object.freeze({ version: LIVE_ARCHIVE_VERSION, archiveCreatedTsMs: createdTs, oneMinute, source: 'broad-kraken-rolling-1m-capture', limitations: ['ROLLING_WINDOW_ONLY'] });
  };
}
