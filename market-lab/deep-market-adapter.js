// MARKET LAB — the deepMarketSource adapter for the existing Social research strainer (§12): builds the v1 deep-market
// window input from the owner's ACTUAL retained windows and hands it to validateDeepMarketWindow. Only USD observations
// with lawful completed window endpoints, an actual trade aggregate, an accepted book with its age and supported
// reference notionals may fill the *Usd fields. Anything unrepresentable returns an honest unsupported result — the v1
// contract is never bent to conceal a quote or clock mismatch.
import { validateDeepMarketWindow, RESEARCH_MARKET_CONTRACT_VERSION } from '../rumor2/social-research-market.js';
import { tradeWindow } from './recipes.js';
import { MINUTE_MS } from './time.js';

export const DEEP_MARKET_ADAPTER_VERSION = 'deep-market-adapter-1';
export const UNSUPPORTED_REASONS = Object.freeze(['NO_OWNER_VIEW', 'QUOTE_NOT_USD', 'WINDOW_NOT_COMPLETE', 'NO_TRADES_RETAINED', 'WINDOW_EMPTY', 'BOOK_UNAVAILABLE', 'VALIDATION_FAILED']);
export function deepMarketWindowInput({ view, canonicalCoin, knownAtTs, windowMs = MINUTE_MS, referenceNotionalsUsd = [1000, 10000] }) {
  if (!view || !view.subject) return { ok: false, reason: 'NO_OWNER_VIEW' };
  if (view.subject.quote !== 'USD') return { ok: false, reason: 'QUOTE_NOT_USD' };
  const endTs = Math.floor(knownAtTs / windowMs) * windowMs; const startTs = endTs - windowMs;
  if (endTs <= 0 || endTs > knownAtTs) return { ok: false, reason: 'WINDOW_NOT_COMPLETE' };
  const trades = view.trades.filter((t) => t.sourceEventTs !== null && t.knownAtTs <= knownAtTs);
  if (!trades.length) return { ok: false, reason: 'NO_TRADES_RETAINED' };
  const w = tradeWindow(trades, { startTs, endTs, evictedUntilTs: view.evictedTradesUntilTs, coverageGap: false });
  const book = [...view.bookSamples].filter((b) => b.receivedTs <= knownAtTs).sort((a, b) => b.receivedTs - a.receivedTs)[0] ?? null;
  if (w.observedCount === 0 && !book) return { ok: false, reason: 'WINDOW_EMPTY' }; // nothing accepted inside the window and no book: honestly unsupported, never an empty 'UNAVAILABLE' window
  const known = w.flow.unknownCount === 0 && w.observedCount > 0;
  const input = { contractVersion: RESEARCH_MARKET_CONTRACT_VERSION, venue: view.subject.venue, canonicalCoin, symbol: view.subject.nativeSymbol, windowStartTs: startTs, windowEndTs: endTs, observedTs: Math.max(endTs, book ? book.receivedTs : endTs), knownAtTs, state: book ? (book.synced && knownAtTs - book.receivedTs <= 15_000 ? 'SYNCHRONIZED' : book.synced ? 'STALE' : 'UNSYNCHRONIZED') : 'UNAVAILABLE', priceStart: w.open, priceEnd: w.close,
    trades: w.observedCount > 0 ? { source: 'kraken-ws-v2-accepted-trades', count: w.observedCount, takerSideKnown: known, buyNotionalUsd: known ? w.flow.buyNotional : null, sellNotionalUsd: known ? w.flow.sellNotional : null, totalNotionalUsd: known ? w.flow.buyNotional + w.flow.sellNotional : (w.quoteNotional ?? 0) } : null,
    book: book ? { source: 'kraken-ws-v2-accepted-book', synchronized: book.synced, observedTs: book.receivedTs, bids: book.bids.slice(0, 200), asks: book.asks.slice(0, 200) } : null, referenceNotionalsUsd: referenceNotionalsUsd.slice(0, 8) };
  const v = validateDeepMarketWindow(input);
  return v.ok ? { ok: true, input, window: v.window } : { ok: false, reason: 'VALIDATION_FAILED', error: v.error };
}
// the pure adapter the strainer calls: (canonicalCoin, { knownAtTs }) => deep-market window input | null
export const createDeepMarketSource = (owner, { referenceNotionalsUsd } = {}) => (canonicalCoin, { knownAtTs }) => { const r = deepMarketWindowInput({ view: owner.view(canonicalCoin), canonicalCoin, knownAtTs, referenceNotionalsUsd }); return r.ok ? r.input : null; };
export const explainDeepMarket = (owner, canonicalCoin, knownAtTs) => deepMarketWindowInput({ view: owner.view(canonicalCoin), canonicalCoin, knownAtTs });
