// Daily tape universe: every online USD-quoted Kraken spot pair that clears
// the liquidity floor, minus stablecoin/fiat bases. Selected once per ET
// session, never intraday. Named display seeds grant no eligibility, depth,
// floor exemption or reserved seat. A failed venue read supplies no new universe.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { nowIso, sessionDate } from '../lib/time.js';

const ASSET_PAIRS_URL = 'https://api.kraken.com/0/public/AssetPairs';
const TICKER_URL = 'https://api.kraken.com/0/public/Ticker';

const universeDir = () => path.join(dataDir(), 'tape', 'universe');
const currentFile = () => path.join(universeDir(), 'current.json');

// Kraken's REST wsnames still use legacy bases; WebSocket v2 uses the
// modern ones. Normalize so the tape subscribes symbols v2 accepts.
const BASE_ALIASES = { XBT: 'BTC', XDG: 'DOGE' };
export const DEEP_UNIVERSE_SELECTION_VERSION = 'equal-eligibility-volume-ranked-2';
const volumeOrder = (a, b) => (b.usdVol24h ?? 0) - (a.usdVol24h ?? 0)
  || String(a.coin).localeCompare(String(b.coin)); // deterministic tie only, no named priority
const usdVolumeOf = (ticker) => {
  const volume = Number(ticker?.v?.[1]); const vwap = Number(ticker?.p?.[1]);
  if (!Number.isFinite(volume) || volume < 0 || !Number.isFinite(vwap) || vwap <= 0) return null;
  const usd = volume * vwap;
  return Number.isFinite(usd) ? usd : null;
};

// Pure selection over raw venue payloads — the testable heart.
// assetPairs: Kraken AssetPairs result map; tickers: Ticker result map.
export function selectFromRaw(assetPairs, tickers, config = loadConfig()) {
  const x = config.universeExpansion;
  const exclude = new Set(x.excludeBases.map((b) => b.toUpperCase()));
  const out = [];
  for (const [key, pair] of Object.entries(assetPairs)) {
    if (pair.status !== 'online') continue; // cancel_only / post_only are not tradeable tape
    if (pair.quote !== 'ZUSD' && pair.quote !== 'USD') continue;
    const wsname = pair.wsname;
    if (typeof wsname !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}\/USD$/.test(wsname)) continue;
    const rawBase = wsname.split('/')[0];
    const coin = BASE_ALIASES[rawBase] ?? rawBase;
    if (exclude.has(coin.toUpperCase())) continue; // stable-vs-stable and fiat
    const ticker = tickers[key];
    const usdVol24h = usdVolumeOf(ticker);
    if (!Number.isFinite(usdVol24h) || usdVol24h < x.minUsdVolume24h) continue;
    out.push({
      coin,
      symbol: `${coin}/USD`, // WS v2 symbol, aliases normalized
      major: false, // retained DTO field only; no asset receives this privilege
      depth: x.defaultDepth,
      usdVol24h: Number.isFinite(usdVol24h) ? Math.round(usdVol24h) : null,
    });
  }
  // Dedupe by symbol (alias keys like XBTUSD/XXBTZUSD collapse to one).
  const seen = new Set();
  const deduped = out.filter((p) => (seen.has(p.symbol) ? false : seen.add(p.symbol)));
  deduped.sort(volumeOrder);
  return deduped;
}

// Wide-eye nominations proposed for the next session (written by /survey).
// Read as a plain file to keep the tape free of survey imports.
function readWideEyeNominations() {
  const file = path.join(dataDir(), 'survey', 'nominations-current.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')).nominations ?? [];
  } catch {
    return [];
  }
}

// Merge nominated symbols that clear the RELAXED floor, then enforce the hard
// deep-universe cap: all eligible candidates compete by volume; lowest shed
// first. The wide eye can propose — only this selection (and then the deep
// tape itself) verifies.
export function mergeNominationsAndCap(pairs, nominations, assetPairs, tickers, config = loadConfig()) {
  const x = config.universeExpansion;
  const w = config.wideeye ?? {};
  const floor = w.nominationFloorUsd ?? 2_000_000;
  const cap = w.deepUniverseCap ?? 30;
  const out = pairs.map((p) => ({ ...p, major: false, depth: x.defaultDepth }));
  const have = new Set(pairs.map((p) => p.coin));
  for (const nom of nominations) {
    if (have.has(nom.coin)) continue;
    // re-verify against the venue's own data, never the nomination's claim
    const entry = Object.entries(assetPairs).find(([, p]) => {
      if (p.status !== 'online' || (p.quote !== 'ZUSD' && p.quote !== 'USD') || !/^[A-Z0-9][A-Z0-9.]{0,14}\/USD$/.test(p.wsname ?? '')) return false;
      const raw = p.wsname.split('/')[0];
      const coin = BASE_ALIASES[raw] ?? raw;
      return coin === nom.coin && !x.excludeBases.includes(coin);
    });
    if (!entry) continue;
    const t = tickers[entry[0]];
    const usdVol24h = usdVolumeOf(t);
    if (!Number.isFinite(usdVol24h) || usdVol24h < floor) continue;
    out.push({ coin: nom.coin, symbol: `${nom.coin}/USD`, major: false, depth: x.defaultDepth, usdVol24h: Math.round(usdVol24h), nominated: true });
    have.add(nom.coin);
  }
  const ranked = out.sort(volumeOrder);
  return { pairs: ranked.slice(0, cap), shed: ranked.slice(cap).map((p) => p.coin) };
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.error?.length) throw new Error(`${url} -> ${body.error.join('; ')}`);
  return body.result;
}

// Select today's universe from the venue; persist it (atomic). On REST
// failure returns UNAVAILABLE, never an unverified named-coin fallback.
export async function selectUniverse(config = loadConfig(), { fetchImpl = fetch } = {}) {
  const date = sessionDate();
  const unavailable = (error) => {
    const record = { date, selectedAt: nowIso(), source: 'UNAVAILABLE', selectionVersion: DEEP_UNIVERSE_SELECTION_VERSION, count: 0, pairs: [], error };
    // Withdraw the admission source without deleting prior dated observations.
    // The running tape may retain already observed/pinned subscriptions.
    atomicWriteJson(currentFile(), record, { pretty: true });
    return record;
  };
  if (!config.universeExpansion?.enabled) {
    return unavailable('UNIVERSE_EXPANSION_DISABLED');
  }
  try {
    const [assetPairs, tickers] = await Promise.all([fetchJson(ASSET_PAIRS_URL, fetchImpl), fetchJson(TICKER_URL, fetchImpl)]);
    const base = selectFromRaw(assetPairs, tickers, config);
    const noms = readWideEyeNominations();
    const { pairs, shed } = mergeNominationsAndCap(base, noms, assetPairs, tickers, config);
    if (shed.length) console.log(`[universe] deep cap ${config.wideeye?.deepUniverseCap ?? 30}: shed lowest-volume ${shed.join(', ')}`);
    const record = {
      date,
      selectedAt: nowIso(),
      source: 'kraken REST AssetPairs+Ticker',
      selectionVersion: DEEP_UNIVERSE_SELECTION_VERSION,
      minUsdVolume24h: config.universeExpansion.minUsdVolume24h,
      count: pairs.length,
      pairs,
    };
    atomicWriteJson(path.join(universeDir(), `${date}.json`), record, { pretty: true });
    atomicWriteJson(currentFile(), record, { pretty: true });
    return record;
  } catch (err) {
    return unavailable(String(err.message).slice(0, 250));
  }
}

export function readCurrentUniverse() {
  if (!existsSync(currentFile())) return null;
  const record = JSON.parse(readFileSync(currentFile(), 'utf8'));
  if (record?.selectionVersion !== DEEP_UNIVERSE_SELECTION_VERSION || record.date !== sessionDate() || record.error || record.source === 'UNAVAILABLE') return null;
  return record;
}
