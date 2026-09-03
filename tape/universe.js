// Daily tape universe: every online USD-quoted Kraken spot pair that clears
// the liquidity floor, minus stablecoin/fiat bases. Selected once per ET
// session, never intraday. If the venue can't be asked, the universe falls
// back to the config majors — a smaller truth, never an invented one.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir, venueSymbol } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { nowIso, sessionDate } from '../lib/time.js';

const ASSET_PAIRS_URL = 'https://api.kraken.com/0/public/AssetPairs';
const TICKER_URL = 'https://api.kraken.com/0/public/Ticker';

const universeDir = () => path.join(dataDir(), 'tape', 'universe');
const currentFile = () => path.join(universeDir(), 'current.json');

// Kraken's REST wsnames still use legacy bases; WebSocket v2 uses the
// modern ones. Normalize so the tape subscribes symbols v2 accepts.
const BASE_ALIASES = { XBT: 'BTC', XDG: 'DOGE' };

// Pure selection over raw venue payloads — the testable heart.
// assetPairs: Kraken AssetPairs result map; tickers: Ticker result map.
export function selectFromRaw(assetPairs, tickers, config = loadConfig()) {
  const x = config.universeExpansion;
  const majors = new Set(config.universe);
  const exclude = new Set(x.excludeBases.map((b) => b.toUpperCase()));
  const out = [];
  for (const [key, pair] of Object.entries(assetPairs)) {
    if (pair.status !== 'online') continue; // cancel_only / post_only are not tradeable tape
    if (pair.quote !== 'ZUSD' && pair.quote !== 'USD') continue;
    const wsname = pair.wsname;
    if (!wsname || !wsname.endsWith('/USD')) continue; // no dark-pool/derivative keys
    const rawBase = wsname.split('/')[0];
    const coin = BASE_ALIASES[rawBase] ?? rawBase;
    if (exclude.has(coin.toUpperCase())) continue; // stable-vs-stable and fiat
    const ticker = tickers[key];
    const usdVol24h = ticker ? Number(ticker.v?.[1]) * Number(ticker.p?.[1]) : null;
    const major = majors.has(coin);
    // Majors are always in (they are the engine's trading universe);
    // everything else must clear the liquidity floor with REAL volume data.
    if (!major && (!Number.isFinite(usdVol24h) || usdVol24h < x.minUsdVolume24h)) continue;
    out.push({
      coin,
      symbol: `${coin}/USD`, // WS v2 symbol, aliases normalized
      major,
      depth: major ? x.majorsDepth : x.defaultDepth,
      usdVol24h: Number.isFinite(usdVol24h) ? Math.round(usdVol24h) : null,
    });
  }
  // Dedupe by symbol (alias keys like XBTUSD/XXBTZUSD collapse to one).
  const seen = new Set();
  const deduped = out.filter((p) => (seen.has(p.symbol) ? false : seen.add(p.symbol)));
  // Majors are the engine's trading universe: if the venue payload lost one
  // (delisted key, renamed alias), it still rides — with honest null volume.
  for (const coin of config.universe) {
    if (!deduped.some((p) => p.coin === coin)) {
      deduped.push({ coin, symbol: `${coin}/USD`, major: true, depth: x.majorsDepth, usdVol24h: null });
    }
  }
  deduped.sort((a, b) => (b.usdVol24h ?? 0) - (a.usdVol24h ?? 0));
  return deduped;
}

function fallbackUniverse(config) {
  const x = config.universeExpansion;
  return config.universe.map((coin) => ({
    coin,
    symbol: venueSymbol(coin, config),
    major: true,
    depth: x?.majorsDepth ?? config.tape.bookDepth,
    usdVol24h: null,
  }));
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.error?.length) throw new Error(`${url} -> ${body.error.join('; ')}`);
  return body.result;
}

// Select today's universe from the venue; persist it (atomic). On REST
// failure returns the majors-only fallback, flagged so the caller can log.
export async function selectUniverse(config = loadConfig()) {
  const date = sessionDate();
  if (!config.universeExpansion?.enabled) {
    return { date, source: 'config-majors (expansion disabled)', pairs: fallbackUniverse(config) };
  }
  try {
    const [assetPairs, tickers] = await Promise.all([fetchJson(ASSET_PAIRS_URL), fetchJson(TICKER_URL)]);
    const pairs = selectFromRaw(assetPairs, tickers, config);
    const record = {
      date,
      selectedAt: nowIso(),
      source: 'kraken REST AssetPairs+Ticker',
      minUsdVolume24h: config.universeExpansion.minUsdVolume24h,
      count: pairs.length,
      pairs,
    };
    atomicWriteJson(path.join(universeDir(), `${date}.json`), record, { pretty: true });
    atomicWriteJson(currentFile(), record, { pretty: true });
    return record;
  } catch (err) {
    return {
      date,
      source: `FALLBACK config-majors (universe fetch failed: ${err.message})`,
      pairs: fallbackUniverse(config),
      error: err.message,
    };
  }
}

export function readCurrentUniverse() {
  if (!existsSync(currentFile())) return null;
  return JSON.parse(readFileSync(currentFile(), 'utf8'));
}
