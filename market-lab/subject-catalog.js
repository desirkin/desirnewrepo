// MARKET LAB — subject resolution against REAL native catalogs (§4/§5). A requested subject (subjects.json) is resolved
// per provider through that provider's own catalog method: Kraken AssetPairs, Coinbase products, Kraken Futures
// instruments, Deribit census, Bybit instruments, CoinGecko coins list, Tokenomist token list. Ambiguity or absence
// REJECTS that provider join (recorded), never a fuzzy match. The observed population and every admission / rejection
// is recorded with the mapping's known-at clock.
import { deepFreeze, subjectId } from './contracts.js';

export const RESOLUTION_STATES = Object.freeze(['RESOLVED', 'NOT_IN_CATALOG', 'AMBIGUOUS_MAPPING', 'CATALOG_NOT_LOADED', 'COIN_MALFORMED', 'NOT_REQUESTED', 'PROVIDER_DISABLED', 'CATALOG_FAILED']);
export async function resolveSubjects({ subjects, clients, enabled = () => true, signal = null, log = () => {} }) {
  const results = []; const catalogs = {};
  const load = async (id, fn) => { if (!enabled(id) || !clients[id]) { catalogs[id] = { state: enabled(id) ? 'NOT_CONSTRUCTED' : 'PROVIDER_DISABLED' }; return; } try { const r = await fn(); catalogs[id] = r.ok ? { state: 'LOADED', requestId: r.meta?.requestId ?? r.catalog?.requestId ?? null, knownAtTs: r.meta?.receivedTs ?? r.catalog?.observedTs ?? null, count: r.count ?? r.catalog?.markets?.length ?? r.observations?.length ?? null } : { state: 'CATALOG_FAILED', failure: r.failure }; } catch (err) { catalogs[id] = { state: 'CATALOG_FAILED', failure: { kind: 'INTERNAL', reason: String(err?.message ?? err).slice(0, 120) } }; } };
  await load('KRAKEN_SPOT', () => clients.KRAKEN_SPOT.loadCatalog({ signal }));
  await load('COINBASE_SPOT', () => clients.COINBASE_SPOT.loadProducts({ signal }));
  await load('KRAKEN_DERIVATIVES', () => clients.KRAKEN_DERIVATIVES.loadInstruments({ signal }));
  await load('BYBIT', () => clients.BYBIT.loadInstruments({ signal }));
  await load('COINGECKO', () => clients.COINGECKO.loadCoinsList({ signal }));
  await load('TOKENOMIST', () => clients.TOKENOMIST.tokenList({ signal }));
  const deribitCurrencies = new Set(subjects.subjects.map((s) => s.deribit).filter(Boolean));
  for (const cur of deribitCurrencies) await load('DERIBIT', () => clients.DERIBIT.loadInstruments({ currency: cur, kind: 'option', signal }));
  for (const s of subjects.subjects) {
    const per = {};
    const attempt = (id, wanted, fn) => { if (wanted === null) { per[id] = { state: 'NOT_REQUESTED' }; return; } if (!enabled(id)) { per[id] = { state: 'PROVIDER_DISABLED' }; return; } if (catalogs[id]?.state !== 'LOADED') { per[id] = { state: catalogs[id]?.state === 'CATALOG_FAILED' ? 'CATALOG_FAILED' : 'CATALOG_NOT_LOADED' }; return; } const r = fn(); per[id] = r.ok ? { state: 'RESOLVED', ...r, subjectId: subjectId(r.market?.subject ?? r.subject ?? r.asset?.subject) } : { state: r.reason ?? 'NOT_IN_CATALOG', candidates: r.candidates ?? null }; };
    attempt('KRAKEN_SPOT', s.krakenSpot, () => clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: s.canonicalCoin, nativeSymbol: s.krakenSpot }));
    attempt('COINBASE_SPOT', s.coinbase, () => clients.COINBASE_SPOT.resolveProduct({ canonicalCoin: s.canonicalCoin, productId: s.coinbase }));
    attempt('KRAKEN_DERIVATIVES', s.krakenDerivatives, () => { const r = clients.KRAKEN_DERIVATIVES.resolveInstrument(s.krakenDerivatives); return r.ok && r.spec.base !== s.canonicalCoin ? { ok: false, reason: 'AMBIGUOUS_MAPPING' } : r; });
    attempt('BYBIT', s.bybit, () => { const r = clients.BYBIT.resolveInstrument(s.bybit); return r.ok && r.spec.base !== s.canonicalCoin ? { ok: false, reason: 'AMBIGUOUS_MAPPING' } : r; });
    attempt('COINGECKO', s.coingecko, () => clients.COINGECKO.resolveAsset({ canonicalCoin: s.canonicalCoin, coingeckoId: s.coingecko }));
    attempt('TOKENOMIST', s.tokenomist, () => clients.TOKENOMIST.resolve({ canonicalCoin: s.canonicalCoin, slug: s.tokenomist }));
    if (s.deribit !== null) { const c = enabled('DERIBIT') && clients.DERIBIT ? clients.DERIBIT.censusOf(s.deribit, 'option') : null; per.DERIBIT = !enabled('DERIBIT') ? { state: 'PROVIDER_DISABLED' } : !c ? { state: catalogs.DERIBIT?.state === 'CATALOG_FAILED' ? 'CATALOG_FAILED' : 'CATALOG_NOT_LOADED' } : c.instruments.size === 0 ? { state: 'NOT_IN_CATALOG' } : { state: 'RESOLVED', currency: s.deribit, census: { total: c.total, complete: c.complete, knownAtTs: c.receivedTs } }; } else per.DERIBIT = { state: 'NOT_REQUESTED' };
    results.push({ canonicalCoin: s.canonicalCoin, providers: per, requested: s });
  }
  return deepFreeze({ catalogs, results, population: results.map((r) => r.canonicalCoin) });
}
