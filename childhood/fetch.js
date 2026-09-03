// Polite historical fetchers. Kraken public REST, ~1.1s spacing, bounded
// budgets, exponential backoff on errors. Everything fetched is recorded
// with retrieval provenance by the callers.
const OHLC_URL = 'https://api.kraken.com/0/public/OHLC';
const TRADES_URL = 'https://api.kraken.com/0/public/Trades';
const ASSET_PAIRS_URL = 'https://api.kraken.com/0/public/AssetPairs';
const SPACING_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;

async function politeGet(url) {
  const wait = lastReq + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error?.length) throw new Error(body.error.join('; '));
      return body.result;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

const BASE_ALIASES = { XBT: 'BTC', XDG: 'DOGE' };

// Today's online USD spot pairs (C-WIDE exclusions). Point-in-time listing
// status is NOT served by any public endpoint; callers must mark historical
// eligibility from candle evidence, never from this list projected backward.
export async function fetchUsdPairs(excludeBases) {
  const assetPairs = await politeGet(ASSET_PAIRS_URL);
  const out = new Map(); // coin -> pairKey
  const excluded = new Set(excludeBases.map((b) => b.toUpperCase()));
  for (const [key, p] of Object.entries(assetPairs)) {
    if (p.status !== 'online' || (p.quote !== 'ZUSD' && p.quote !== 'USD') || !p.wsname?.endsWith('/USD')) continue;
    const raw = p.wsname.split('/')[0];
    const coin = BASE_ALIASES[raw] ?? raw;
    if (excluded.has(coin.toUpperCase()) || out.has(coin)) continue;
    out.set(coin, key);
  }
  return out;
}

// One OHLC call: [[t,o,h,l,c,v],...] ascending, numeric. Venue serves at
// most ~720 candles per interval — that cap is a recorded fact, not fought.
export async function fetchOhlc(pairKey, intervalMin) {
  const r = await politeGet(`${OHLC_URL}?pair=${pairKey}&interval=${intervalMin}`);
  const key = Object.keys(r).find((k) => k !== 'last');
  return (r[key] ?? []).map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[6])]);
}

// Trades enrichment for majors: pages forward from `sinceSec` under a hard
// per-symbol request budget. Returns 15m-bucket aggression imbalance
// (buyVol - sellVol)/(total) plus the honest coverage window.
export async function fetchAggression(pairKey, sinceSec, maxRequests) {
  const buckets = new Map(); // bucketTs -> {buy, sell}
  let since = String(BigInt(sinceSec) * 1_000_000_000n);
  let requests = 0;
  let lastTradeSec = null;
  let firstTradeSec = null;
  while (requests < maxRequests) {
    const r = await politeGet(`${TRADES_URL}?pair=${pairKey}&since=${since}`);
    requests++;
    const key = Object.keys(r).find((k) => k !== 'last');
    const trades = r[key] ?? [];
    if (!trades.length) break;
    for (const t of trades) {
      const ts = Number(t[2]);
      firstTradeSec ??= ts;
      lastTradeSec = ts;
      const bucket = Math.floor(ts / 900) * 900;
      const b = buckets.get(bucket) ?? { buy: 0, sell: 0 };
      if (t[3] === 'b') b.buy += Number(t[1]);
      else b.sell += Number(t[1]);
      buckets.set(bucket, b);
    }
    since = r.last;
    if (lastTradeSec && lastTradeSec >= Date.now() / 1000 - 60) break; // caught up
  }
  const imbalance = {};
  for (const [ts, b] of buckets) {
    const total = b.buy + b.sell;
    imbalance[ts] = total > 0 ? Number(((b.buy - b.sell) / total).toFixed(4)) : null;
  }
  return { imbalance, coverage: { fromSec: firstTradeSec, toSec: lastTradeSec, requests } };
}
