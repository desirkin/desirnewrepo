// Daily rollup: what did we actually eat today, net of modeled fees/slippage.
// Excursions are measured from persisted tape snapshots between entry and
// exit — if the tape wasn't recording, the excursion is null, not guessed.
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readJsonl } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { sessionDate, nowIso } from '../lib/time.js';
import { allPredictions, allFills, allExits } from './ledger.js';

function snapshotsFor(date) {
  return readJsonl(path.join(dataDir(), 'tape', date, 'snapshots.jsonl'));
}

function excursions(fill, exit, snapshots) {
  const t0 = Date.parse(fill.ts);
  const t1 = Date.parse(exit.ts);
  const mids = snapshots
    .filter((s) => s.coin === fill.coin)
    .filter((s) => {
      const t = Date.parse(s.ts);
      return t >= t0 && t <= t1;
    })
    .map((s) => s.mid);
  if (!mids.length) return { favorablePct: null, adversePct: null };
  const entry = fill.avg_price;
  return {
    favorablePct: ((Math.max(...mids) - entry) / entry) * 100,
    adversePct: ((Math.min(...mids) - entry) / entry) * 100,
  };
}

// Rolls up all trades whose EXIT landed on `date` (ET session date).
export function dailyRollup(date = sessionDate()) {
  const fills = new Map(allFills().map((f) => [f.prediction_id, f]));
  const predictions = new Map(allPredictions().map((p) => [p.prediction_id, p]));
  const exits = allExits().filter((e) => sessionDate(new Date(e.ts)) === date);
  const snapshots = snapshotsFor(date);

  const trades = exits.map((exit) => {
    const fill = fills.get(exit.prediction_id);
    const prediction = predictions.get(exit.prediction_id);
    const exc = fill ? excursions(fill, exit, snapshots) : { favorablePct: null, adversePct: null };
    return {
      prediction_id: exit.prediction_id,
      coin: exit.coin,
      thesis: prediction?.thesis ?? null,
      size_usd: fill?.size_usd ?? null,
      entry_ts: fill?.ts ?? null,
      exit_ts: exit.ts,
      reason_code: exit.reason_code,
      realized_net_usd: exit.realized_net_usd,
      realized_net_pct: exit.realized_net_pct,
      fees_usd: (fill?.fee_usd ?? 0) + exit.fee_usd,
      favorable_excursion_pct: exc.favorablePct,
      adverse_excursion_pct: exc.adversePct,
    };
  });

  const n = trades.length;
  const wins = trades.filter((t) => t.realized_net_usd > 0).length;
  const netUsd = trades.reduce((s, t) => s + t.realized_net_usd, 0);
  const feesUsd = trades.reduce((s, t) => s + t.fees_usd, 0);
  const withExc = trades.filter((t) => t.favorable_excursion_pct !== null);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

  const rollup = {
    session_date: date,
    generated_at: nowIso(),
    trades: n,
    wins,
    win_rate: n ? wins / n : null,
    net_usd: netUsd,
    net_expectancy_per_trade_usd: n ? netUsd / n : null,
    fees_paid_modeled_usd: feesUsd,
    avg_favorable_excursion_pct: avg(withExc.map((t) => t.favorable_excursion_pct)),
    avg_adverse_excursion_pct: avg(withExc.map((t) => t.adverse_excursion_pct)),
    trade_log: trades,
  };

  const outDir = path.join(dataDir(), 'ledger', 'rollups');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${date}.json`), JSON.stringify(rollup, null, 2));
  return rollup;
}

// Realized paper P&L (USD) for a session date — feeds the /state daily locks.
export function realizedPnlUsd(date = sessionDate()) {
  return allExits()
    .filter((e) => sessionDate(new Date(e.ts)) === date)
    .reduce((s, e) => s + e.realized_net_usd, 0);
}
