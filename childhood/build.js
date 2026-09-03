// B-0 + B-0A orchestrator: fetch layered history politely, replay forward on
// CLOSED bars only, freeze observations (with knowledge-time provenance),
// then label outcomes separately. Event-aware DISCOVERY/EMBARGO/VALIDATION
// splits. A pre-existing archive is superseded, never mixed.
// Run: node childhood/build.js
import path from 'node:path';
import { existsSync, renameSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { CandleStore, retBetween } from './store.js';
import { replaySymbol, RANDOM_SEED, BASELINE_STRATA } from './replay.js';
import { labelObservation } from './labeler.js';
import { assignSplits, MAX_HORIZON_SEC } from './splits.js';
import { fetchUsdPairs, fetchOhlc, fetchAggression } from './fetch.js';
import { fetchGovernance, fetchIncidentHistory } from './deepmemory.js';

const OUT = () => path.join(dataDir(), 'childhood');
const log = (m) => console.log(`[${nowIso()}] ${m}`);

const config = loadConfig();
const wideCfg = config.wideeye;
const retrievedTs = nowIso();
const gaps = [
  'Kraken OHLC serves ~720 candles/interval: 1m history limited to ~12h, 5m to ~2.5d, 15m to ~7.5d — no 30d density below 1h (verified live; see doctrine/CHILDHOOD.md)',
  'No public L2 history exists: absorption/refill/cancel = UNKNOWN_HISTORICALLY outside trades enrichment',
  'Point-in-time listing status not served by any public endpoint: eligibility is candle-evidenced (TRADED_AT_TS) or UNKNOWN',
];

// ---- supersede any earlier archive: never mix rule generations
if (existsSync(OUT())) {
  const dev = `${OUT()}-superseded-${Date.now()}`;
  renameSync(OUT(), dev);
  log(`existing archive superseded -> ${path.basename(dev)} (development artifact only; never merged)`);
}

// ---- universe
const pairKeys = await fetchUsdPairs(config.universeExpansion.excludeBases);
const allCoins = [...pairKeys.keys()];
const deepCoins = (readCurrentUniverse()?.pairs ?? config.universe.map((c) => ({ coin: c }))).map((p) => p.coin).filter((c) => pairKeys.has(c));
log(`universe today: ${allCoins.length} USD pairs; deep tape: ${deepCoins.length}; majors: ${config.universe.join(',')}`);

// ---- fetch tracks
const TRACKS = [
  { intervalMin: 60, coins: allCoins },
  { intervalMin: 15, coins: allCoins },
  { intervalMin: 5, coins: deepCoins },
  { intervalMin: 1, coins: deepCoins },
];
const stores = new Map();
for (const t of TRACKS) {
  const m = new Map();
  stores.set(t.intervalMin, m);
  let done = 0;
  for (const coin of t.coins) {
    try {
      const candles = await fetchOhlc(pairKeys.get(coin), t.intervalMin);
      if (candles.length >= 20) {
        m.set(coin, new CandleStore(coin, t.intervalMin * 60, candles));
        appendJsonl(path.join(OUT(), `candles-${t.intervalMin}m.jsonl`), { symbol: coin, intervalMin: t.intervalMin, retrievedTs, candles });
      }
    } catch (err) {
      gaps.push(`OHLC ${coin}@${t.intervalMin}m failed: ${err.message}`);
    }
    if (++done % 100 === 0) log(`  ${t.intervalMin}m track: ${done}/${t.coins.length} fetched`);
  }
  log(`${t.intervalMin}m track: ${m.size} symbols with candles`);
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
    log(`trades ${coin}: ${r.coverage.requests} requests, coverage from ${r.coverage.fromSec ? new Date(r.coverage.fromSec * 1000).toISOString() : 'none'}`);
    if (r.coverage.toSec && Date.now() / 1000 - r.coverage.toSec > 120) {
      gaps.push(`trades ${coin}: budget exhausted before catching up (coverage ends ${new Date(r.coverage.toSec * 1000).toISOString()})`);
    }
  } catch (err) {
    gaps.push(`trades ${coin} failed: ${err.message}`);
  }
}

// ---- per-track context, closed-bar keyed (ts = bar CLOSE time)
function buildContext(trackStores, intervalSec) {
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

// ---- replay + label
const obsFile = path.join(OUT(), 'observations.jsonl');
const outFile = path.join(OUT(), 'outcomes.jsonl');
const counts = {
  byPopulation: {},
  byClassification: {},
  byTag: {},
  byTrack: {},
  bySplit: {},
  byAvailability: {},
  tradeEnriched: 0,
};
const splitBoundaries = {};
let totalUniqueEvents = 0;

for (const t of TRACKS) {
  const trackStores = stores.get(t.intervalMin);
  if (!trackStores.size) continue;
  const intervalSec = t.intervalMin * 60;
  const { contextAt, median1hAt } = buildContext(trackStores, intervalSec);
  const trackName = `${t.intervalMin}m`;
  const allObs = [];
  for (const [coin, store] of trackStores) {
    const agg = aggression.get(coin);
    allObs.push(
      ...replaySymbol({
        replayViews: store.replayViews(),
        symbol: coin,
        intervalSec,
        track: trackName,
        cfg: wideCfg,
        contextAt,
        retrievedTs,
        aggression: agg ? { imbalance: agg.imbalance, bucketSec: 900 } : null,
      })
    );
  }
  allObs.sort((a, b) => a.ts - b.ts);
  if (!allObs.length) continue;
  const t0 = allObs[0].ts;
  const t1 = allObs.at(-1).ts;
  const nominal = Math.round(t0 + 0.7 * (t1 - t0));
  const { uniqueEvents } = assignSplits(allObs, nominal);
  totalUniqueEvents += uniqueEvents;
  splitBoundaries[trackName] = {
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
    counts.bySplit[obs.split] = (counts.bySplit[obs.split] ?? 0) + 1;
    for (const [f, state] of Object.entries(obs.dataAvailability)) {
      counts.byAvailability[`${f}:${state}`] = (counts.byAvailability[`${f}:${state}`] ?? 0) + 1;
    }
    if (obs.dataAvailability.microstructure === 'KNOWN') counts.tradeEnriched++;
    const outcome = labelObservation(obs, trackStores.get(obs.symbol), ctxStores);
    appendJsonl(outFile, outcome);
    for (const tag of outcome.outcomeTags) counts.byTag[tag] = (counts.byTag[tag] ?? 0) + 1;
  }
  log(`${trackName} replay: ${allObs.length} observations (${uniqueEvents} unique events) frozen & labeled`);
}

// ---- deep memory
log('deep memory: governance (snapshot) + incident archive');
const gov = await fetchGovernance(allCoins);
for (const r of gov.records) appendJsonl(path.join(OUT(), 'governance.jsonl'), r);
gaps.push(...gov.gaps);
const lockCounts = { MATHEMATICALLY_LOCKED: 0, STATISTICALLY_NEAR_CERTAIN: 0, UNKNOWN: 0 };
for (const r of gov.records) lockCounts[r.lock.status] = (lockCounts[r.lock.status] ?? 0) + 1;
let incidentCount = 0;
try {
  const incidents = await fetchIncidentHistory(stores.get(60));
  for (const i of incidents) appendJsonl(path.join(OUT(), 'incidents.jsonl'), i);
  incidentCount = incidents.length;
} catch (err) {
  gaps.push(`incident archive failed: ${err.message}`);
}

// ---- reproducibility manifest (B-0A §6)
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
const manifest = {
  schemaVersion: 'childhood-observation-2',
  childhoodVersion: 'B0A-1',
  wideEyeLogicVersion: `wideeye-1 (z>=${wideCfg.zVolThreshold}/|z|>=${wideCfg.zRetThreshold}/ext<=${wideCfg.extensionCapPct}%, unchanged from live)`,
  labelerVersion: 'outcome-tags-1 (multi-label deterministic)',
  universeRuleVersion: 'candle-evidenced-eligibility-1',
  provenanceRuleVersion: 'availableTs-1 (knowledge time distinct from source time)',
  sourceDatasetIdentifiers: [
    'https://api.kraken.com/0/public/OHLC',
    'https://api.kraken.com/0/public/Trades',
    'https://api.kraken.com/0/public/AssetPairs',
    'https://hub.snapshot.org/graphql',
    'https://status.kraken.com/api/v2/incidents.json',
  ],
  sourceChecksumsSha256_16: Object.fromEntries(
    TRACKS.map((t) => [`candles-${t.intervalMin}m.jsonl`, sha(path.join(OUT(), `candles-${t.intervalMin}m.jsonl`))])
  ),
  randomSeed: RANDOM_SEED,
  samplingStrata: BASELINE_STRATA,
  codeCommit: commit,
  archiveCreatedTs: nowIso(),
  charter: 'doctrine/CHILDHOOD.md',
  universeToday: allCoins.length,
  deepUniverse: deepCoins,
  tracks: Object.fromEntries(
    TRACKS.map((t) => {
      const m = stores.get(t.intervalMin);
      const spans = [...m.values()].map((s) => [s.candles[0][0], s.candles.at(-1)[0]]);
      return [
        `${t.intervalMin}m`,
        {
          symbols: m.size,
          from: spans.length ? new Date(Math.min(...spans.map((s) => s[0])) * 1000).toISOString() : null,
          to: spans.length ? new Date(Math.max(...spans.map((s) => s[1])) * 1000).toISOString() : null,
        },
      ];
    })
  ),
  counts: { ...counts, uniqueEvents: totalUniqueEvents, governanceProposals: gov.records.length, governanceLocks: lockCounts, incidents: incidentCount },
  splits: splitBoundaries,
  embargoHorizonSec: MAX_HORIZON_SEC,
  tradesCoverage: Object.fromEntries([...aggression.entries()].map(([c, r]) => [c, r.coverage])),
  knownGaps: gaps,
  note: 'B-0/B-0A builds memory; it proves nothing. No performance numbers are reported here by design.',
};
atomicWriteJson(path.join(OUT(), 'manifest.json'), manifest, { pretty: true });
log('manifest written');
console.log(JSON.stringify({ counts: manifest.counts, splits: splitBoundaries, knownGaps: gaps.length }, null, 2));
