// MARKET LAB — the deepMarketSource adapter for the existing Social research strainer (§12, closeout R02): builds the v1
// deep-market window input from the owner's ACTUAL retained windows and hands it to validateDeepMarketWindow. Only USD
// observations with lawful completed window endpoints, an actual trade aggregate over a POSITIVELY covered interval, an
// accepted book with its age and supported reference notionals may fill the *Usd fields. When the v1 contract cannot
// represent the required completeness (unknown or partial trade coverage) the trade aggregate is WITHHELD (trades: null)
// with the exact diagnostic — the v1 contract itself is never bent and never changed.
import { validateDeepMarketWindow, RESEARCH_MARKET_CONTRACT_VERSION } from '../rumor2/social-research-market.js';
import { tradeWindow, intervalCoverage } from './recipes.js';
import { subjectId } from './contracts.js';
import { MINUTE_MS } from './time.js';

export const DEEP_MARKET_ADAPTER_VERSION = 'deep-market-adapter-2';
export const UNSUPPORTED_REASONS = Object.freeze(['NO_OWNER_VIEW', 'QUOTE_NOT_USD', 'WINDOW_NOT_COMPLETE', 'NO_TRADES_RETAINED', 'WINDOW_EMPTY', 'BOOK_UNAVAILABLE', 'VALIDATION_FAILED']);
export const TRADE_WITHHELD_REASONS = Object.freeze(['TRADE_COVERAGE_UNKNOWN', 'TRADE_COVERAGE_PARTIAL']);
export function deepMarketWindowInput({ view, coverage = [], canonicalCoin, knownAtTs, windowMs = MINUTE_MS, referenceNotionalsUsd = [1000, 10000] }) {
  if (!view || !view.subject) return { ok: false, reason: 'NO_OWNER_VIEW' };
  if (view.subject.quote !== 'USD') return { ok: false, reason: 'QUOTE_NOT_USD' };
  const endTs = Math.floor(knownAtTs / windowMs) * windowMs; const startTs = endTs - windowMs;
  if (endTs <= 0 || endTs > knownAtTs) return { ok: false, reason: 'WINDOW_NOT_COMPLETE' };
  const trades = view.trades.filter((t) => t.sourceEventTs !== null && t.knownAtTs <= knownAtTs);
  const book = [...view.bookSamples].filter((b) => b.receivedTs <= knownAtTs).sort((a, b) => b.receivedTs - a.receivedTs)[0] ?? null;
  const sid = subjectId(view.subject); const cov = intervalCoverage(coverage.filter((c) => c.subjectId === sid && c.kind === 'TRADE'), { startTs, endTs, asOfTs: knownAtTs });
  const w = tradeWindow(trades, { startTs, endTs, evictedUntilTs: view.evictedTradesUntilTs, coverage: cov });
  if (w.observedCount === 0 && !book) return { ok: false, reason: 'WINDOW_EMPTY' }; // nothing accepted inside the window and no book: honestly unsupported, never an empty 'UNAVAILABLE' window
  // the trade aggregate is a lawful interval total ONLY over a positively covered, complete interval; otherwise it is withheld with the reason
  const complete = w.support.state === 'COMPLETE' || w.support.state === 'COMPLETE_NO_TRADES';
  const withheld = complete ? null : cov.state === 'UNKNOWN' ? 'TRADE_COVERAGE_UNKNOWN' : 'TRADE_COVERAGE_PARTIAL';
  if (!complete && !book) return { ok: false, reason: 'WINDOW_EMPTY', withheld };
  const known = w.flow.unknownCount === 0 && w.observedCount > 0;
  const input = { contractVersion: RESEARCH_MARKET_CONTRACT_VERSION, venue: view.subject.venue, canonicalCoin, symbol: view.subject.nativeSymbol, windowStartTs: startTs, windowEndTs: endTs, observedTs: Math.max(endTs, book ? book.receivedTs : endTs), knownAtTs, state: book ? (book.synced && knownAtTs - book.receivedTs <= 15_000 ? 'SYNCHRONIZED' : book.synced ? 'STALE' : 'UNSYNCHRONIZED') : 'UNAVAILABLE', priceStart: complete ? w.open : null, priceEnd: complete ? w.close : null,
    trades: complete && w.observedCount > 0 ? { source: 'kraken-ws-v2-accepted-trades', count: w.observedCount, takerSideKnown: known, buyNotionalUsd: known ? w.flow.buyNotional : null, sellNotionalUsd: known ? w.flow.sellNotional : null, totalNotionalUsd: known ? w.flow.buyNotional + w.flow.sellNotional : (w.quoteNotional ?? 0) } : null,
    book: book ? { source: 'kraken-ws-v2-accepted-book', synchronized: book.synced, observedTs: book.receivedTs, bids: book.bids.slice(0, 200), asks: book.asks.slice(0, 200) } : null, referenceNotionalsUsd: referenceNotionalsUsd.slice(0, 8) };
  const v = validateDeepMarketWindow(input);
  return v.ok ? { ok: true, input, window: v.window, coverage: { state: cov.state, support: w.support.state, withheld, observedCount: w.observedCount } } : { ok: false, reason: 'VALIDATION_FAILED', error: v.error, withheld };
}
// the pure adapter the strainer calls: (canonicalCoin, { knownAtTs }) => deep-market window input | null
export const createDeepMarketSource = (owner, { referenceNotionalsUsd } = {}) => (canonicalCoin, { knownAtTs }) => { const r = deepMarketWindowInput({ view: owner.view(canonicalCoin), coverage: owner.coverage(), canonicalCoin, knownAtTs, referenceNotionalsUsd }); return r.ok ? r.input : null; };
export const explainDeepMarket = (owner, canonicalCoin, knownAtTs) => deepMarketWindowInput({ view: owner.view(canonicalCoin), coverage: owner.coverage(), canonicalCoin, knownAtTs });
