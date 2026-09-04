// Read-only ledger summary for the cockpit panel. Computes everything from
// the persisted JSONL ledger and the tape's current books — display can
// never place, modify, or cancel anything. Unknown numbers are null.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { sessionDate, nowIso } from '../lib/time.js';
import { allPredictions, allFills, allExits } from './ledger.js';
import { readCurrentBook, readTapeStatus, TAPE_STATES } from '../tape/store.js';

const ET_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function etStamp(iso) {
  return ET_STAMP.format(new Date(iso)).replace(',', '');
}

// Distinct ET session dates the tape has recorded — "days on watch".
function daysOnWatch() {
  const dir = path.join(dataDir(), 'tape');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).length;
}

export function ledgerSummary(now = new Date()) {
  const config = loadConfig();
  const startingBalance = config.paper.baseBalanceUsd;
  const today = sessionDate(now);

  const fills = new Map(allFills().map((f) => [f.prediction_id, f]));
  const exits = allExits().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const closed = exits
    .map((exit) => {
      const fill = fills.get(exit.prediction_id);
      if (!fill) return null;
      const entryMs = Date.parse(fill.ts);
      const exitMs = Date.parse(exit.ts);
      return {
        prediction_id: exit.prediction_id,
        etTime: etStamp(exit.ts),
        entryTs: fill.ts,
        exitTs: exit.ts,
        // holding time only where both timestamps actually parse — never invented
        holdMin: Number.isFinite(entryMs) && Number.isFinite(exitMs) ? Math.max(0, (exitMs - entryMs) / 60_000) : null,
        symbol: exit.coin,
        side: 'LONG',
        sizeUsd: fill.size_usd,
        entry: fill.avg_price,
        exit: exit.avg_price,
        netUsd: exit.realized_net_usd,
        netPct: exit.realized_net_pct ?? null,
        result: exit.realized_net_usd > 0 ? 'W' : 'L',
        exitReason: exit.reason_code,
        feesUsd: fill.fee_usd + exit.fee_usd,
      };
    })
    .filter(Boolean);

  const netPnl = closed.reduce((s, t) => s + t.netUsd, 0);
  const todayTrades = closed.filter((t) => sessionDate(new Date(t.exitTs)) === today);
  const todayPnl = todayTrades.reduce((s, t) => s + t.netUsd, 0);
  const winsArr = closed.filter((t) => t.netUsd > 0);
  const lossArr = closed.filter((t) => t.netUsd <= 0);
  const avg = (arr) => (arr.length ? arr.reduce((s, t) => s + t.netUsd, 0) / arr.length : null);

  const perSymbol = {};
  for (const t of closed) {
    const p = (perSymbol[t.symbol] ??= { trades: 0, netUsd: 0 });
    p.trades++;
    p.netUsd += t.netUsd;
  }

  // Open positions marked against the live book mid; stale/missing book -> null mark.
  const tape = readTapeStatus();
  const tapeLive =
    tape && tape.state === TAPE_STATES.LIVE && (Date.now() - tape.tsMs) / 1000 <= (tape.staleFeedSec ?? 10) * 2;
  const exited = new Set(exits.map((e) => e.prediction_id));
  const open = [...fills.values()]
    .filter((f) => !exited.has(f.prediction_id))
    .map((f) => {
      let mark = null;
      let unrealizedUsd = null;
      if (tapeLive) {
        const book = readCurrentBook(f.coin);
        if (book?.synced && (Date.now() - book.tsMs) / 1000 <= config.cost.maxBookAgeSec) {
          const bid = book.bids[0]?.price;
          const ask = book.asks[0]?.price;
          if (bid && ask) {
            mark = (bid + ask) / 2;
            unrealizedUsd = f.base_qty * mark - (f.size_usd + f.fee_usd);
          }
        }
      }
      return {
        prediction_id: f.prediction_id,
        symbol: f.coin,
        sizeUsd: f.size_usd,
        entry: f.avg_price,
        entryTs: f.ts ?? null,
        entryFeeUsd: f.fee_usd ?? null,
        ageMin: f.ts && Number.isFinite(Date.parse(f.ts)) ? Math.max(0, (Date.now() - Date.parse(f.ts)) / 60_000) : null,
        mark,
        unrealizedUsd,
      };
    });

  // UI-1 quality metrics — exact arithmetic over existing records only.
  // Profit factor with no losses is honestly null (rendered N/A), never ∞.
  const grossWinUsd = winsArr.reduce((s, t) => s + t.netUsd, 0);
  const grossLossUsd = lossArr.reduce((s, t) => s + t.netUsd, 0); // ≤ 0
  const profitFactor = grossLossUsd < 0 ? grossWinUsd / Math.abs(grossLossUsd) : null;
  const exitReasons = {};
  for (const t of closed) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;

  return {
    generatedAt: nowIso(),
    startingBalance,
    currentBalance: startingBalance + netPnl,
    grossWinUsd,
    grossLossUsd,
    profitFactor,
    avgNetPerClosedUsd: closed.length ? netPnl / closed.length : null,
    exitReasons,
    netPnl: { usd: netPnl, pct: (netPnl / startingBalance) * 100 },
    todayPnl: { usd: todayPnl, pct: (todayPnl / startingBalance) * 100 },
    totalTrades: closed.length,
    wins: winsArr.length,
    losses: lossArr.length,
    winRatePct: closed.length ? (winsArr.length / closed.length) * 100 : null,
    avgWinUsd: avg(winsArr),
    avgLossUsd: avg(lossArr),
    largestWinUsd: winsArr.length ? Math.max(...winsArr.map((t) => t.netUsd)) : null,
    largestLossUsd: lossArr.length ? Math.min(...lossArr.map((t) => t.netUsd)) : null,
    totalFeesPaid: closed.reduce((s, t) => s + t.feesUsd, 0),
    perSymbol,
    lastTrades: closed.slice(-20).reverse(),
    openPositions: open,
    daysOnWatch: daysOnWatch(),
    pendingPredictions: allPredictions().length - fills.size,
  };
}
