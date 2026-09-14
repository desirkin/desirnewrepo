// EXECUTION — the read-only LEDGER VIEW of the journal (2026-09-14, lean trim step 1).
// ONE bankroll, ONE truth: every number the cockpit's ledger drawer, the paper preflight and the posture machine used to
// take from the legacy JSONL ledger (ledger/, now attic/) is derived HERE from the reduced execution-journal state and
// published inside the composition's projection. Pure function of (state, clock): no file, no network, no authority.
// Money arrives as exact decimal strings (execution/money.js) and leaves as JavaScript numbers at this edge only — the
// view is for humans and dashboards, never an input to a decision.
import * as M from './money.js';
import { ownedBase } from './reducer.js';
import { sessionDate, etStamp } from '../lib/time.js';

export const LEDGER_VIEW_VERSION = 'journal-ledger-view-1';
const num = (d) => (d === null || d === undefined ? null : Number(d));
const pct = (usd, base) => (base === null || base === 0 || usd === null ? null : (usd / base) * 100);

function closedTrade(p) {
  const base = num(p.confirmedBase); const entryQuote = num(p.entryQuote); const exitQuote = num(p.exitQuote);
  const feesUsd = num(M.add(p.entryFeesQuote ?? '0', p.exitFeesQuote ?? '0'));
  const netUsd = p.realizedPnl === null || p.realizedPnl === undefined ? null : num(p.realizedPnl);
  const entryMs = p.firstFillTs ?? null; const exitMs = p.closedTs ?? null;
  return {
    positionId: p.positionId, prediction_id: p.decisionId ?? p.positionId, symbol: p.pair, side: 'LONG',
    etTime: Number.isSafeInteger(exitMs) ? etStamp(exitMs) : null,
    entryTs: entryMs, exitTs: exitMs,
    holdMin: Number.isSafeInteger(entryMs) && Number.isSafeInteger(exitMs) ? Math.max(0, (exitMs - entryMs) / 60_000) : null,
    sizeUsd: entryQuote,
    entry: base > 0 && entryQuote !== null ? entryQuote / base : null,
    exit: base > 0 && exitQuote !== null ? exitQuote / base : null,
    netUsd, netPct: pct(netUsd, entryQuote),
    result: netUsd === null ? 'UNKNOWN' : netUsd > 0 ? 'W' : 'L',
    exitReason: p.closeReason ?? null,
    feesUsd,
  };
}

function openPosition(p, nowMs) {
  const base = num(ownedBase(p)); const entryQuote = num(p.entryQuote); const mark = p.lastMark ?? null;
  const liquidation = mark && mark.liquidationValue !== null && mark.liquidationValue !== undefined ? num(mark.liquidationValue) : null;
  return {
    positionId: p.positionId, symbol: p.pair, state: p.state,
    sizeUsd: entryQuote, base,
    entry: num(p.confirmedBase) > 0 && entryQuote !== null ? entryQuote / num(p.confirmedBase) : null,
    entryTs: p.firstFillTs ?? null,
    entryFeeUsd: num(p.entryFeesQuote),
    ageMin: Number.isSafeInteger(p.firstFillTs) ? Math.max(0, (nowMs - p.firstFillTs) / 60_000) : null,
    // the Watch's conservative liquidation mark, or null — never an invented mid
    mark: liquidation !== null && base > 0 ? liquidation / base : null,
    markTs: mark?.ts ?? null,
    unrealizedUsd: liquidation !== null && entryQuote !== null ? liquidation - entryQuote - (num(p.entryFeesQuote) ?? 0) : null,
  };
}

// state: the reduced journal state (dispatcher.state()); nowMs: the composition clock.
export function ledgerView(state, { nowMs, maxTrades = 20 } = {}) {
  if (!state || typeof state !== 'object') return null;
  const positions = Object.values(state.positions ?? {});
  const pendingEntries = Object.values(state.orders ?? {}).filter((o) => (o.kind === 'ENTRY' || o.kind === 'CANARY_ENTRY') && !['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.state)).length;
  const closed = positions.filter((p) => p.state === 'FLAT' && p.firstFillTs !== null).map(closedTrade).sort((a, b) => (a.exitTs ?? 0) - (b.exitTs ?? 0));
  const open = positions.filter((p) => p.state !== 'FLAT' && !M.isZero(ownedBase(p))).map((p) => openPosition(p, nowMs));
  const scored = closed.filter((t) => t.netUsd !== null);
  const wins = scored.filter((t) => t.netUsd > 0); const losses = scored.filter((t) => t.netUsd <= 0);
  const sum = (arr) => arr.reduce((s, t) => s + t.netUsd, 0); const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);
  const today = sessionDate(new Date(nowMs)); const todayTrades = scored.filter((t) => Number.isSafeInteger(t.exitTs) && sessionDate(new Date(t.exitTs)) === today);
  const perSymbol = {}; for (const t of scored) { const s = (perSymbol[t.symbol] ??= { trades: 0, netUsd: 0 }); s.trades += 1; s.netUsd += t.netUsd; }
  const exitReasons = {}; for (const t of closed) exitReasons[t.exitReason ?? 'UNKNOWN'] = (exitReasons[t.exitReason ?? 'UNKNOWN'] ?? 0) + 1;
  const grossWinUsd = sum(wins); const grossLossUsd = sum(losses);
  const account = state.accountId ?? null; const cash = num(state.cash);
  const equity = state.valuation && !state.valuation.unknown ? num(state.valuation.equity) : null;
  const session = state.performance?.session ?? null;
  const openingEquity = session ? num(session.openingEquity) : null; const dayPnl = session ? num(session.dayPnl) : null;
  const netPnl = sum(scored); const startingBalance = num(state.initialCapital);
  return {
    ledgerViewVersion: LEDGER_VIEW_VERSION, generatedTs: nowMs, accountId: account,
    startingBalance, currentBalance: startingBalance === null ? null : startingBalance + netPnl, pendingPredictions: pendingEntries,
    cash, equity, valuationUnknown: Boolean(state.valuation?.unknown),
    session: session ? { date: session.date, openingEquity, dayPnl, dayPnlPct: pct(dayPnl, openingEquity) } : null,
    netPnl: { usd: netPnl, pct: pct(netPnl, openingEquity) },
    todayPnl: { usd: sum(todayTrades), pct: pct(sum(todayTrades), openingEquity) },
    totalTrades: closed.length, scoredTrades: scored.length, unknownOutcomeTrades: closed.length - scored.length,
    wins: wins.length, losses: losses.length,
    winRatePct: scored.length ? (wins.length / scored.length) * 100 : null,
    grossWinUsd, grossLossUsd,
    profitFactor: grossLossUsd < 0 ? grossWinUsd / Math.abs(grossLossUsd) : null,
    avgNetPerClosedUsd: avg(scored), avgWinUsd: avg(wins), avgLossUsd: avg(losses),
    largestWinUsd: wins.length ? Math.max(...wins.map((t) => t.netUsd)) : null,
    largestLossUsd: losses.length ? Math.min(...losses.map((t) => t.netUsd)) : null,
    totalFeesPaid: closed.reduce((s, t) => s + (t.feesUsd ?? 0), 0),
    realizedFeesUsd: num(state.realized?.fees ?? null),
    exitReasons, perSymbol,
    lastTrades: closed.slice(-maxTrades).reverse(),
    openPositions: open,
  };
}
