// B-0/B-0A/B-0B orchestrator. Builds a candidate childhood in a STAGING
// directory (the authoritative archive is untouched throughout), validates
// it, and promotes only on a clean validation. Coarse tracks are
// CONTEXT_ONLY; the 1m track runs the true PARITY_SCOUT engine — but REST 1m
// depth (~12h) is below the 24h volume warm-up, so no live-equivalent signal
// can be scored from it and fastMemoryParityStatus records exactly that.
// Run: node childhood/build.js
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { CandleStore, retBetween } from './store.js';
import { replayContext, replayParity, buildMinuteGrid, RANDOM_SEED, BASELINE_STRATA } from './replay.js';
import { labelObservation } from './labeler.js';
import { assignSplits, MAX_HORIZON_SEC } from './splits.js';
import { fetchUsdPairs, fetchOhlc, fetchAggression } from './fetch.js';
import { fetchGovernance, fetchIncidentHistory } from './deepmemory.js';
import { validateChildhood, EXPECTED_SCHEMA_VERSION } from './validate.js';
import { promoteStaging } from './promote.js';

const AUTHORITATIVE = () => path.join(dataDir(), 'childhood');
const runId = Date.now();
const STAGING = () => path.join(dataDir(), `childhood-staging-${runId}`);
const log = (m) => console.log(`[${nowIso()}] ${m}`);

const config = loadConfig();
const wideCfg = config.wideeye;
const gaps = [
  'Kraken OHLC serves ~720 candles/interval: 1m history limited to ~12h, 5m to ~2.5d, 15m to ~7.5d — no 30d density below 1h (verified live)',
  'No public L2 history exists: absorption/refill/cancel = UNKNOWN_HISTORICALLY outside trades enrichment',
  'Point-in-time listing status not served by any public endpoint: eligibility is candle-evidenced (TRADED_AT_TS) or UNKNOWN',
  'Universe reconstruction starts from TODAY\'s AssetPairs: pairs delisted before today are invisible — SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET',
];
const FAST_MEMORY_PARITY_STATUS = 'UNAVAILABLE_WITH_CURRENT_SOURCE';
const PARITY_BLOCKER =
  'REST 1m depth (~12h) < 24h rolling-volume warm-up + 7d baseline; Kraken downloadable OHLCVT is quarterly via Google Drive (recon 2026-09-03): latest data ends at the prior quarter boundary and cannot cover a current 30-day window; multi-GB unauthenticated Drive retrieval is operationally unreasonable here. PARITY_SCOUT engine implemented and fixture-proven; awaiting an adequate source.';

log(`building into staging: ${path.basename(STAGING())} (authoritative untouched until validated promotion)`);

// ---- universe (today's; survivorship limitation recorded, never hidden)
const pairKeys = await fetchUsdPairs(config.universeExpansion.excludeBases);
const allCoins = [...pairKeys.keys()];
const deepCoins = (readCurrentUniverse()?.pairs ?? config.universe.map((c) => ({ coin: c }))).map((p) => p.coin).filter((c) => pairKeys.has(c));
log(`universe today: ${allCoins.length} USD pairs; deep tape: ${deepCoins.length}`);

// ---- fetch tracks (completed candles only; retrievedSec recorded per line)
const TRACKS = [
  { intervalMin: 60, coins: allCoins, role: 'CONTEXT_ONLY' },
  { intervalMin: 15, coins: allCoins, role: 'CONTEXT_ONLY' },
  { intervalMin: 5, coins: deepCoins, role: 'CONTEXT_ONLY' },
  { intervalMin: 1, coins: deepCoins, role: 'PARITY_SCOUT' },
];
const stores = new Map();
const retrievalIso = new Map(); // intervalMin -> Map(coin -> ACTUAL retrieval ISO of that fetch)
let sourceLatestTs = 0;
for (const t of TRACKS) {
  const m = new Map();
  stores.set(t.intervalMin, m);
  retrievalIso.set(t.intervalMin, new Map());
  let done = 0;
  for (const coin of t.coins) {
    try {
      const { candles, retrievedSec } = await fetchOhlc(pairKeys.get(coin), t.intervalMin);
      if (candles.length >= 20) {
        // coverage extends through retrieval time: REST serves the complete
        // series to now, so bar-less final minutes mean "no trades", not
        // "dataset ended" (B-0B.1 §1). Retrieval provenance is the ACTUAL
        // per-fetch timestamp, never a build-start stamp (§4).
        m.set(coin, new CandleStore(coin, t.intervalMin * 60, candles, { coverageEndSec: retrievedSec }));
        retrievalIso.get(t.intervalMin).set(coin, new Date(retrievedSec * 1000).toISOString());
        sourceLatestTs = Math.max(sourceLatestTs, candles.at(-1)[0] + t.intervalMin * 60);
        appendJsonl(path.join(STAGING(), `candles-${t.intervalMin}m.jsonl`), {
          symbol: coin,
          intervalMin: t.intervalMin,
          retrievedTs: new Date(retrievedSec * 1000).toISOString(),
          retrievedSec,
          candles,
        });
      }
    } catch (err) {
      gaps.push(`OHLC ${coin}@${t.intervalMin}m failed: ${err.message}`);
    }
    if (++done % 100 === 0) log(`  ${t.intervalMin}m track: ${done}/${t.coins.length} fetched`);
  }
  log(`${t.intervalMin}m track (${t.role}): ${m.size} symbols with completed candles`);
}

// ---- trades enrichment (majors, hard budget)
const aggression = new Map();
const budget = config.childhood?.tradesRequestBudgetPerMajor ?? 30;
for (const coin of config.universe) {
  if (!pairKeys.has(coin)) continue;
  try {
    const since = Math.floor(Date.now() / 1000) - 6 * 3600;
    const r = await fetchAggression(pairKeys.get(coin), since, budget);
    aggression.set(coin, r);
    if (r.coverage.toSec && Date.now() / 1000 - r.coverage.toSec > 120) {
      gaps.push(`trades ${coin}: budget exhausted before catching up (coverage ends ${new Date(r.coverage.toSec * 1000).toISOString()})`);
    }
  } catch (err) {
    gaps.push(`trades ${coin} failed: ${err.message}`);
  }
}

// ---- per-track trailing context (closed-bar keyed) + labeler-only forward median
function buildContextFns(trackStores, intervalSec) {
  const perTs = new Map();
  for (const s of trackStores.values()) {
    for (let i = 1; i < s.candles.length; i++) {
      const r = retBetween(s.candles[i][4], s.candles[i - 1][4]);
      if (r === null) continue;
      const closeTs = s.candles[i][0] + intervalSec;
      (perTs.get(closeTs) ?? perTs.set(closeTs, []).get(closeTs)).push(r);
    }
  }
  const median = (arr) => {
    if (!arr?.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const tick = (coin, closeTs) => {
    const s = trackStores.get(coin);
    if (!s) return null;
    const i = s.candles.findIndex((c) => c[0] + intervalSec === closeTs);
    if (i < 1) return null;
    return retBetween(s.candles[i][4], s.candles[i - 1][4]);
  };
  const contextAt = (closeTs) => ({
    btcRet: tick('BTC', closeTs),
    ethRet: tick('ETH', closeTs),
    universeMedianRet: median(perTs.get(closeTs)),
    atHorizon: '1tick-trailing-closed-bar',
  });
  const fwdCache = new Map();
  const median1hAt = (ts) => {
    if (fwdCache.has(ts)) return fwdCache.get(ts);
    const rets = [];
    for (const s of trackStores.values()) {
      if (!s.coversHorizon(ts, 3600)) continue; // full-horizon discipline (B-0B.1 §1)
      const now = s.atOrBefore(ts);
      const later = s.future(ts, 3600).at(-1);
      if (!now || !later) continue;
      const r = retBetween(later[4], now[4]);
      if (r !== null) rets.push(r * 100);
    }
    const m = median(rets);
    fwdCache.set(ts, m);
    return m;
  };
  return { contextAt, median1hAt };
}

// ---- replay + label into staging
const obsFile = path.join(STAGING(), 'observations.jsonl');
const outFile = path.join(STAGING(), 'outcomes.jsonl');
const counts = {
  byPopulation: {},
  byClassification: {},
  byTag: {},
  byTrack: {},
  byTrackRole: {},
  bySplit: {},
  byAvailability: {},
  wouldEmitLive: { true: 0, false: 0 },
  tradeEnriched: 0,
};
const splitBoundaries = {};
let totalUniqueEvents = 0;

for (const t of TRACKS) {
  const trackStores = stores.get(t.intervalMin);
  if (!trackStores.size) continue;
  const intervalSec = t.intervalMin * 60;
  const { contextAt, median1hAt } = buildContextFns(trackStores, intervalSec);
  const trackName = `${t.intervalMin}m`;
  const allObs = [];
  for (const [coin, store] of trackStores) {
    if (t.role === 'PARITY_SCOUT') {
      const agg = aggression.get(coin);
      allObs.push(
        ...replayParity({
          minuteSamples: buildMinuteGrid(store.candles),
          symbol: coin,
          cfg: wideCfg,
          contextAt,
          retrievedTs: retrievalIso.get(t.intervalMin).get(coin),
          aggression: agg ? { imbalance: agg.imbalance, bucketSec: 900 } : null,
        })
      );
    } else {
      allObs.push(
        ...replayContext({
          replayViews: store.replayViews(),
          symbol: coin,
          intervalSec,
          track: trackName,
          contextAt,
          retrievedTs: retrievalIso.get(t.intervalMin).get(coin),
        })
      );
    }
  }
  allObs.sort((a, b) => a.ts - b.ts);
  if (!allObs.length) continue;
  const t0 = allObs[0].ts;
  const t1 = allObs.at(-1).ts;
  const nominal = Math.round(t0 + 0.7 * (t1 - t0));
  const { uniqueEvents } = assignSplits(allObs, nominal);
  totalUniqueEvents += uniqueEvents;
  splitBoundaries[trackName] = {
    role: t.role,
    from: t0,
    to: t1,
    nominalSplitTs: nominal,
    discoveryLastUsableTs: nominal - MAX_HORIZON_SEC,
    embargoStart: nominal - MAX_HORIZON_SEC,
    embargoEnd: nominal,
    validationFirstUsableTs: nominal,
    uniqueEvents,
  };

  const ctxStores = Object.fromEntries([...trackStores.entries()]);
  ctxStores.median1hAt = median1hAt;
  for (const obs of allObs) {
    appendJsonl(obsFile, obs);
    counts.byPopulation[obs.population] = (counts.byPopulation[obs.population] ?? 0) + 1;
    counts.byClassification[obs.setupClassification] = (counts.byClassification[obs.setupClassification] ?? 0) + 1;
    counts.byTrack[trackName] = (counts.byTrack[trackName] ?? 0) + 1;
    counts.byTrackRole[obs.trackRole] = (counts.byTrackRole[obs.trackRole] ?? 0) + 1;
    counts.bySplit[obs.split] = (counts.bySplit[obs.split] ?? 0) + 1;
    if (obs.wouldEmitLive !== null && obs.wouldEmitLive !== undefined) counts.wouldEmitLive[String(obs.wouldEmitLive)]++;
    for (const [f, state] of Object.entries(obs.dataAvailability)) {
      counts.byAvailability[`${f}:${state}`] = (counts.byAvailability[`${f}:${state}`] ?? 0) + 1;
    }
    if (obs.dataAvailability.microstructure === 'KNOWN') counts.tradeEnriched++;
    const outcome = labelObservation(obs, trackStores.get(obs.symbol), ctxStores);
    appendJsonl(outFile, outcome);
    for (const tag of outcome.outcomeTags) counts.byTag[tag] = (counts.byTag[tag] ?? 0) + 1;
  }
  log(`${trackName} (${t.role}): ${allObs.length} observations (${uniqueEvents} unique events) frozen & labeled`);
}

// ---- deep memory
log('deep memory: governance (paginated, with vote timelines) + incident archive');
const gov = await fetchGovernance(allCoins, { log });
for (const r of gov.records) appendJsonl(path.join(STAGING(), 'governance.jsonl'), r);
gaps.push(...gov.gaps);
const lockCounts = {};
for (const r of gov.records) lockCounts[r.lock.status] = (lockCounts[r.lock.status] ?? 0) + 1;
let incidentCount = 0;
let incidentOutcomeCount = 0;
try {
  // WALL: incident facts and their post-hoc price outcomes go to SEPARATE
  // files, linked by incidentId (B-0B.1 §8) — the future never sits inside
  // an object replay could consume as contemporary evidence.
  const { incidents, incidentOutcomes } = await fetchIncidentHistory(stores.get(60));
  for (const i of incidents) appendJsonl(path.join(STAGING(), 'incidents.jsonl'), i);
  for (const o of incidentOutcomes) appendJsonl(path.join(STAGING(), 'incident-outcomes.jsonl'), o);
  incidentCount = incidents.length;
  incidentOutcomeCount = incidentOutcomes.length;
} catch (err) {
  gaps.push(`incident archive failed: ${err.message}`);
}

// ---- reproducibility manifest (B-0B §18)
const sha = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
};
let commit = null;
try {
  commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch {
  // not a git checkout on deployment
}
const totalObs = Object.values(counts.byTrack).reduce((s, v) => s + v, 0);
const manifest = {
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  childhoodVersion: 'B0B',
  wideEyeLiveLogicVersion: `eyecore-1 (z>=${wideCfg.zVolThreshold}/|z|>=${wideCfg.zRetThreshold}/ext<=${wideCfg.extensionCapPct}%, minSamples=${wideCfg.minSamples}, cooldown=${wideCfg.rippleCooldownMin}m, add-then-score, 7d retention)`,
  wideEyeReplayParityVersion: 'parity-2 (shared eyecore incl. feature derivers; true 1m grid; rolling-24h volRate; live cooldown; no coarse-track wide-eye output)',
  // Live sweeps run on a wall-clock ~60s cadence (not calendar-minute
  // aligned) and select trailing samples with small slack; replay walks a
  // true calendar-minute grid. The FORMULAS are shared (eyecore); the
  // sampling phase is not identical and is not claimed to be.
  parityScope: 'SEMANTIC_PARITY_ON_60S_SAMPLING_GRID',
  fastMemoryParityStatus: FAST_MEMORY_PARITY_STATUS,
  fastMemoryParityBlocker: PARITY_BLOCKER,
  historicalSourceType: 'kraken REST OHLC (720-candle cap per interval), completed bars only',
  historicalSourceCoverage: Object.fromEntries(
    TRACKS.map((t) => {
      const m = stores.get(t.intervalMin);
      const spans = [...m.values()].map((s) => [s.candles[0][0], s.candles.at(-1)[0] + t.intervalMin * 60]);
      return [
        `${t.intervalMin}m`,
        {
          role: t.role,
          symbols: m.size,
          from: spans.length ? new Date(Math.min(...spans.map((s) => s[0])) * 1000).toISOString() : null,
          to: spans.length ? new Date(Math.max(...spans.map((s) => s[1])) * 1000).toISOString() : null,
        },
      ];
    })
  ),
  sourceLatestTs: sourceLatestTs ? new Date(sourceLatestTs * 1000).toISOString() : null,
  warmupFromTs: null, // no parity-capable source: no warm-up window exists
  archivedChildhoodFromTs: null, // parity childhood not generated (see blocker)
  archivedChildhoodToTs: null,
  universeCoverageStatus: 'SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET',
  universeCoverageExplanation:
    "The pair list comes from today's AssetPairs; pairs delisted before today cannot appear, so historical completeness of the universe is NOT claimed. TRADED_AT_TS proves trading occurred; KNOWN_ONLINE_AT_TS and LIVE_RULES_ELIGIBLE_AT_TS are unavailable historically -> UNKNOWN.",
  liveMinSamples: wideCfg.minSamples,
  historicalMinSamples: wideCfg.minSamples, // exact parity — no relaxation
  baselineWindowDays: 7,
  volumeFeatureDefinition:
    'max(0, delta of rolling 24h base volume between consecutive 1m samples); reconstructed from 1m bars on PARITY_SCOUT; raw bar volume on CONTEXT_ONLY is stored as barVolume and never called volRate',
  cooldownMin: wideCfg.rippleCooldownMin,
  sourceDatasetIdentifiers: [
    'https://api.kraken.com/0/public/OHLC',
    'https://api.kraken.com/0/public/Trades',
    'https://api.kraken.com/0/public/AssetPairs',
    'https://hub.snapshot.org/graphql',
    'https://status.kraken.com/api/v2/incidents.json',
  ],
  sourceChecksumsSha256_16: Object.fromEntries(
    TRACKS.map((t) => [`candles-${t.intervalMin}m.jsonl`, sha(path.join(STAGING(), `candles-${t.intervalMin}m.jsonl`))])
  ),
  randomSeed: RANDOM_SEED,
  samplingStrata: BASELINE_STRATA,
  codeCommit: commit,
  archiveCreatedTs: nowIso(),
  charter: 'doctrine/CHILDHOOD.md',
  universeToday: allCoins.length,
  deepUniverse: deepCoins,
  counts: {
    ...counts,
    observations: totalObs,
    uniqueEvents: totalUniqueEvents,
    governanceProposals: gov.records.length,
    governanceVotesRetrieved: gov.voteStats.votesRetrieved,
    governanceTimelinesComplete: gov.voteStats.timelinesComplete,
    governanceTimelinesUnavailable: gov.voteStats.timelinesUnavailable,
    governanceLocks: lockCounts,
    incidents: incidentCount,
    incidentOutcomes: incidentOutcomeCount,
  },
  splits: splitBoundaries,
  embargoHorizonSec: MAX_HORIZON_SEC,
  tradesCoverage: Object.fromEntries([...aggression.entries()].map(([c, r]) => [c, r.coverage])),
  knownGaps: gaps,
  note: 'B-0/B-0A/B-0B builds memory; it proves nothing. No performance numbers are reported here by design.',
};
atomicWriteJson(path.join(STAGING(), 'manifest.json'), manifest, { pretty: true });
log('staging manifest written — validating before promotion');

// ---- validate, then promote (fail closed)
const promotion = promoteStaging(STAGING(), AUTHORITATIVE(), { validate: validateChildhood });
if (!promotion.promoted) {
  log(`PROMOTION REFUSED at ${promotion.stage}: authoritative archive untouched`);
  for (const e of promotion.errors.slice(0, 20)) log(`  validator: ${e}`);
  process.exitCode = 1;
} else {
  log(`promoted: staging -> data/childhood${promotion.supersededPath ? `; previous archive superseded at ${path.basename(promotion.supersededPath)}` : ''}`);
  console.log(JSON.stringify({ counts: manifest.counts, splits: splitBoundaries, fastMemoryParityStatus: FAST_MEMORY_PARITY_STATUS, knownGaps: gaps.length }, null, 2));
}
