// One bounded commissioning poll for the existing metadata-only YouTube path.
// The temporary data directory and inert timers ensure this never starts PAPER,
// trading, or a continuous collector and never touches normal runtime state.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startVideo } from '../video/collector.js';
import { readVideoObservations } from '../video/reader.js';

const smokeDir = mkdtempSync(path.join(tmpdir(), 'serpent-youtube-smoke-'));
const inertTimers = {
  setTimeout: () => ({}),
  clearTimeout() {},
  setInterval: () => ({}),
  clearInterval() {},
};
const queries = [
  'cryptocurrency project announcement',
  'crypto protocol update',
  'token listing delisting',
  'blockchain security incident',
];

let runtime = null;
try {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is missing');
  runtime = startVideo({
    env: {
      SOCIAL_VIDEO_ENABLED: 'true',
      YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
      SOCIAL_VIDEO_YOUTUBE_QUERIES: queries.join(','),
      SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: '4',
    },
    dataDir: smokeDir,
    timers: inertTimers,
    firstDelayMs: 86_400_000,
    signals: false,
    log: () => {},
  });
  if (!runtime) throw new Error('video runtime did not compose');
  const result = await runtime.pollOnce();
  const status = runtime.status();
  const observations = readVideoObservations(smokeDir, { limit: 100 });
  console.log(JSON.stringify({
    ok: result?.outcome === 'OBSERVED' || result?.outcome === 'EMPTY',
    paperStarted: false,
    continuousPollingStarted: false,
    authority: status.authority,
    provider: status.provider,
    coverage: status.coverage,
    configuredQueries: queries,
    maximumDailySearches: status.quota.maxDailySearches,
    searchesUsed: status.quota.searchCalls,
    enrichmentUnitsUsed: status.quota.unitsOther,
    outcome: result?.outcome ?? null,
    admitted: result?.admitted ?? 0,
    durableObservations: observations.observations.length,
    corruptObservations: observations.corrupt,
    lastError: status.lastError,
  }, null, 2));
} finally {
  runtime?.stop();
  rmSync(smokeDir, { recursive: true, force: true });
}
