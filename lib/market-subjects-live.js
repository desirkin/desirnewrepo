// lib/market-subjects-live.js — PUBLISH-FIX-13 (2026-09-17, independent review F6): the market-research subjects FOLLOW
// THE TAPE UNIVERSE. `config/market-subjects.paper.json` is an IDENTITY REGISTRY (provider-native ids for coins we
// know: CoinGecko id, CryptoQuant symbol, Tokenomist slug, pools, protocols) — it is never the selection set. The
// selection is the tape's current deep universe (tape/universe.js: eligible USD pairs by volume + wide-eye
// nominations, capped), so every coin the Judge can trade is also the coin the research providers are asked about.
// A universe coin the registry does not know is DERIVED from its ticker: Kraken spot / Kraken derivatives / Coinbase /
// Coinglass identifiers all follow the ticker and are resolved against the providers' own catalogs by the owner (a wrong
// guess is an honest NOT_IN_CATALOG, never a silent zero); CoinGecko / CryptoQuant / Tokenomist need a registered id and
// stay NOT_REQUESTED until the registry learns one. The coverage of every subject is logged at boot. Authority NONE.
import { loadSubjects } from '../market-lab/policy.js';

export const MARKET_SUBJECTS_LIVE_VERSION = 'market-subjects-live-1';
const DERIVATIVES_BASE_ALIAS = Object.freeze({ BTC: 'XBT' });
const NO_DERIVATIVES = new Set(['PAXG']); // Kraken lists no perpetual for these (a registry entry may still name one)

export function deriveSubjectFromTicker(coin, symbol) {
  const base = DERIVATIVES_BASE_ALIAS[coin] ?? coin;
  return {
    canonicalCoin: coin, krakenSpot: symbol ?? `${coin}/USD`, coinbase: `${coin}-USD`,
    krakenDerivatives: NO_DERIVATIVES.has(coin) ? null : `PF_${base}USD`,
    coingecko: null, tokens: [], pools: [], protocols: [], cryptoquant: null, tokenomist: null, coinglass: coin,
  };
}

const coverageOf = (s, source) => ({
  coin: s.canonicalCoin, source,
  providers: { krakenSpot: s.krakenSpot !== null, krakenDerivatives: s.krakenDerivatives !== null, coinbase: s.coinbase !== null, coinglass: s.coinglass !== null, coingecko: s.coingecko !== null, cryptoquant: s.cryptoquant !== null, tokenomist: s.tokenomist !== null },
});

// registry: the validated subjects file. universe: the tape's current selection ({ pairs: [{ symbol, coin }] }) or null.
// Returns { subjects (validated, registry-shaped), coverage, mode }. mode: 'TAPE_UNIVERSE' | 'REGISTRY_FALLBACK'.
export function deriveMarketSubjects({ registry, universe, maxSubjects = 64, log = () => {} }) {
  const byCoin = new Map(registry.subjects.map((s) => [s.canonicalCoin, s]));
  const pairs = Array.isArray(universe?.pairs) ? universe.pairs.filter((p) => p && typeof p.coin === 'string' && /^[A-Z0-9]{2,12}$/.test(p.coin)) : [];
  if (pairs.length === 0) {
    log(`MARKET RESEARCH subjects: tape universe unavailable — falling back to the ${registry.subjects.length}-coin identity registry for this boot (${registry.subjects.map((s) => s.canonicalCoin).join(' ')}); the registry is not the selection law`);
    return { subjects: registry, coverage: registry.subjects.map((s) => coverageOf(s, 'REGISTRY')), mode: 'REGISTRY_FALLBACK' };
  }
  const seen = new Set(); const subjects = []; const coverage = [];
  for (const p of pairs) {
    if (seen.has(p.coin) || subjects.length >= maxSubjects) continue; seen.add(p.coin);
    const known = byCoin.get(p.coin);
    const s = known ? { ...known, krakenSpot: known.krakenSpot ?? p.symbol } : deriveSubjectFromTicker(p.coin, p.symbol);
    subjects.push(s); coverage.push(coverageOf(s, known ? 'REGISTRY' : 'DERIVED'));
  }
  const doc = loadSubjects({ ...registry, subjects }); // the same schema law as the file itself
  const derived = coverage.filter((c) => c.source === 'DERIVED').map((c) => c.coin);
  const noGecko = coverage.filter((c) => !c.providers.coingecko).map((c) => c.coin);
  log(`MARKET RESEARCH subjects follow the tape universe: ${subjects.length} coins (${subjects.map((s) => s.canonicalCoin).join(' ')}); ${coverage.length - derived.length} from the identity registry, ${derived.length} derived from the ticker${derived.length ? ` (${derived.join(' ')})` : ''}; CoinGecko id not registered for ${noGecko.length ? noGecko.join(' ') : 'none'}`);
  return { subjects: doc, coverage, mode: 'TAPE_UNIVERSE' };
}
