// B-0 orchestrator: fetch layered history politely, replay point-in-time,
// freeze observations, then (and only then) label outcomes. Writes the
// childhood archive + manifest. Run: node childhood/build.js
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { CandleStore, retBetween } from './store.js';
import { replaySymbol } from './replay.js';
import { labelObservation } from './labeler.js';
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
const stores = new Map(); // `${interval}` -> Map(coin -> CandleStore)
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
    const from = r.coverage.fromSec ? new Date(r.coverage.fromSec * 1000).toISOString() : 'none';
    log(`trades ${coin}: ${r.coverage.requests} requests, coverage from ${from}`);
    if (r.coverage.toSec && Date.now() / 1000 - r.coverage.toSec > 120) {
      gaps.push(`trades ${coin}: budget exhausted before catching up (coverage ends ${new Date(r.coverage.toSec * 1000).toISOString()})`);
    }
  } catch (err) {
    gaps.push(`trades ${coin} failed: ${err.message}`);
  }
}

// ---- per-track context: point-in-time trailing returns (for replay) and
// forward medians (labeler only)
function buildContext(trackStores) {
  const perTs = new Map(); // ts -> number[] of 1-tick trailing returns
  for (const s of trackStores.values()) {
    for (let i = 1; i < s.candles.length; i++) {
      const r = retBetween(s.candles[i][4], s.candles[i - 1][4]);
      if (r === null) continue;
      const ts = s.candles[i][0];
      (perTs.get(ts) ?? perTs.set(ts, []).get(ts)).push(r);
    }
  }
  const median = (arr) => {
    if (!arr?.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const tick = (coin, ts) => {
    const s = trackStores.get(coin);
    if (!s) return null;
    const i = s.candles.findIndex((c) => c[0] === ts);
    if (i < 1) return null;
    return retBetween(s.candles[i][4], s.candles[i - 1][4]);
  };
  const contextAt = (ts) => ({
    btcRet: tick('BTC', ts),
    ethRet: tick('ETH', ts),
    universeMedianRet: median(perTs.get(ts)),
    atHorizon: '1tick-trailing',
  });
  // labeler-only forward 1h median
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
const counts = { byClassification: {}, byLabel: {}, byTrack: {} };
const splitBoundaries = {};

for (const t of TRACKS) {
  const trackStores = stores.get(t.intervalMin);
  if (!trackStores.size) continue;
  const { contextAt, median1hAt } = buildContext(trackStores);
  const trackName = `${t.intervalMin}m`;
  const allObs = [];
  for (const [coin, store] of trackStores) {
    const agg = aggression.get(coin);
    const aggressionAt = agg
      ? (ts) => agg.imbalance[Math.floor(ts / 900) * 900] ?? null
      : null;
    allObs.push(...replaySymbol({ store, track: trackName, cfg: wideCfg, contextAt, retrievedTs, aggressionAt }));
  }
  allObs.sort((a, b) => a.ts - b.ts);
  const t0 = allObs[0]?.ts;
  const t1 = allObs.at(-1)?.ts;
  const boundary = t0 !== undefined ? t0 + 0.7 * (t1 - t0) : null;
  splitBoundaries[trackName] = boundary ? { boundaryTs: Math.round(boundary), from: t0, to: t1 } : null;

  const ctxStores = Object.fromEntries([...trackStores.entries()]);
  ctxStores.median1hAt = median1hAt;
  for (const obs of allObs) {
    obs.split = boundary && obs.ts > boundary ? 'VALIDATION' : 'DISCOVERY';
    appendJsonl(obsFile, obs);
    counts.byClassification[obs.setupClassification] = (counts.byClassification[obs.setupClassification] ?? 0) + 1;
    counts.byTrack[trackName] = (counts.byTrack[trackName] ?? 0) + 1;
    const outcome = labelObservation(obs, trackStores.get(obs.symbol), ctxStores);
    appendJsonl(outFile, outcome);
    counts.byLabel[outcome.label] = (counts.byLabel[outcome.label] ?? 0) + 1;
  }
  log(`${trackName} replay: ${allObs.length} observations frozen & labeled`);
}

// ---- deep memory
log('deep memory: governance (snapshot) + incident archive');
const gov = await fetchGovernance(allCoins);
for (const r of gov.records) appendJsonl(path.join(OUT(), 'governance.jsonl'), r);
gaps.push(...gov.gaps);
let incidentCount = 0;
try {
  const incidents = await fetchIncidentHistory(stores.get(60));
  for (const i of incidents) appendJsonl(path.join(OUT(), 'incidents.jsonl'), i);
  incidentCount = incidents.length;
} catch (err) {
  gaps.push(`incident archive failed: ${err.message}`);
}

// ---- manifest
const manifest = {
  builtAt: nowIso(),
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
  counts: { ...counts, governanceProposals: gov.records.length, incidents: incidentCount },
  splits: splitBoundaries,
  tradesCoverage: Object.fromEntries([...aggression.entries()].map(([c, r]) => [c, r.coverage])),
  knownGaps: gaps,
  note: 'B-0 builds memory; it proves nothing. No performance numbers are reported here by design.',
};
atomicWriteJson(path.join(OUT(), 'manifest.json'), manifest, { pretty: true });
log('manifest written');
console.log(JSON.stringify({ counts: manifest.counts, splits: manifest.splits, knownGaps: gaps.length }, null, 2));
