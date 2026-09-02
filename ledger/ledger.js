// Paper ledger — the stomach. Every meal recorded, honestly.
//
// PRICE-BLIND ORDERING, ENFORCED IN CODE: recordPrediction() persists the
// prediction (fsync'd) and never touches market data. simulateEntry() is the
// only path to a price fetch, and it begins by re-reading the prediction row
// from disk — if the row isn't durably on disk, there is no price fetch.
// The write path physically precedes the read path.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendJsonl, readJsonl } from '../lib/jsonl.js';
import { loadConfig, dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';
import { readCurrentBook, readTapeStatus, TAPE_STATES } from '../tape/store.js';
import { walkAsksForUsd, walkBidsForQty } from '../cost/model.js';

export const EXIT_REASONS = [
  'TIME_STOP',
  'TARGET',
  'INVALIDATION',
  'CVD_REVERSAL',
  'REGIME_FLIP',
  'DATA_DEGRADED',
  'KILL',
  'CAGE',
];

const predictionsFile = () => path.join(dataDir(), 'ledger', 'predictions.jsonl');
const fillsFile = () => path.join(dataDir(), 'ledger', 'fills.jsonl');
const exitsFile = () => path.join(dataDir(), 'ledger', 'exits.jsonl');

export class PriceBlindViolation extends Error {}

// Step 1 — persist the thesis. No market data is read here, by construction:
// this module's imports of tape reads are used only inside simulateEntry/Exit.
export function recordPrediction({ coin, thesis, horizonMin, predictedNetMovePct, sizeUsd }) {
  const config = loadConfig();
  if (!config.universe.includes(coin)) throw new Error(`${coin} not in universe`);
  if (!thesis || !thesis.trim()) throw new Error('thesis is required — no thesis, no trade');
  const row = {
    prediction_id: randomUUID(),
    timestamp_prediction_persisted: nowIso(),
    coin,
    thesis,
    predicted_horizon_min: horizonMin,
    predicted_net_move_pct: predictedNetMovePct,
    size_usd: sizeUsd,
  };
  appendJsonl(predictionsFile(), row, { sync: true }); // durable BEFORE any price is seen
  return row;
}

function requirePersistedPrediction(predictionId) {
  const row = readJsonl(predictionsFile()).find((p) => p.prediction_id === predictionId);
  if (!row) {
    throw new PriceBlindViolation(
      `prediction ${predictionId} is not persisted on disk — price fetch refused`
    );
  }
  return row;
}

function requireLiveTape(coin) {
  const config = loadConfig();
  const status = readTapeStatus();
  if (!status || status.state !== TAPE_STATES.LIVE) {
    throw new Error(`UNAVAILABLE — NO TRADE (tape ${status?.state ?? 'absent'})`);
  }
  const book = readCurrentBook(coin);
  if (!book) throw new Error(`UNAVAILABLE — NO TRADE (no book for ${coin})`);
  const ageSec = (Date.now() - book.tsMs) / 1000;
  if (ageSec > config.cost.maxBookAgeSec) {
    throw new Error(`UNAVAILABLE — NO TRADE (book stale ${ageSec.toFixed(1)}s)`);
  }
  return book;
}

// Step 2 — simulated taker fill at decision time. The FIRST statement that can
// observe a price is gated behind the persisted-prediction check.
export function simulateEntry(predictionId) {
  const prediction = requirePersistedPrediction(predictionId); // gate: write path first
  if (readJsonl(fillsFile()).some((f) => f.prediction_id === predictionId)) {
    throw new Error(`prediction ${predictionId} already has an entry fill`);
  }
  const config = loadConfig();
  const book = requireLiveTape(prediction.coin); // price fetch happens only past the gate
  const walk = walkAsksForUsd(book.asks, prediction.size_usd);
  if (walk.exhausted) throw new Error(`UNAVAILABLE — NO TRADE (book too thin for $${prediction.size_usd})`);
  const fees = config.fees[config.venue];
  const feeUsd = prediction.size_usd * fees.taker;
  const fill = {
    prediction_id: predictionId,
    ts: nowIso(),
    coin: prediction.coin,
    side: 'buy',
    fill_type: 'taker_walk',
    size_usd: prediction.size_usd,
    base_qty: walk.baseQty,
    avg_price: walk.avgPrice,
    fee_usd: feeUsd,
    entry_cost_snapshot_ref: { book_ts: book.ts },
    fee_schedule_version: config.fees.version,
  };
  appendJsonl(fillsFile(), fill, { sync: true });
  return fill;
}

// Step 3 — simulated exit fill; realized net after modeled fees + slippage.
export function simulateExit(predictionId, reasonCode) {
  if (!EXIT_REASONS.includes(reasonCode)) {
    throw new Error(`unknown exit reason ${reasonCode} — expected one of ${EXIT_REASONS.join(', ')}`);
  }
  const fill = readJsonl(fillsFile()).find((f) => f.prediction_id === predictionId);
  if (!fill) throw new Error(`no entry fill for prediction ${predictionId}`);
  if (readJsonl(exitsFile()).some((e) => e.prediction_id === predictionId)) {
    throw new Error(`prediction ${predictionId} already exited`);
  }
  const config = loadConfig();
  const book = requireLiveTape(fill.coin);
  const walk = walkBidsForQty(book.bids, fill.base_qty);
  if (walk.exhausted) throw new Error(`UNAVAILABLE — NO TRADE (book too thin to exit ${fill.base_qty})`);
  const fees = config.fees[config.venue];
  const exitFeeUsd = walk.proceedsUsd * fees.taker;
  const realizedNetUsd = walk.proceedsUsd - exitFeeUsd - (fill.size_usd + fill.fee_usd);
  const exit = {
    prediction_id: predictionId,
    ts: nowIso(),
    coin: fill.coin,
    reason_code: reasonCode,
    fill_type: 'taker_walk',
    base_qty: fill.base_qty,
    avg_price: walk.avgPrice,
    proceeds_usd: walk.proceedsUsd,
    fee_usd: exitFeeUsd,
    realized_net_usd: realizedNetUsd,
    realized_net_pct: (realizedNetUsd / fill.size_usd) * 100,
    exit_snapshot_ref: { book_ts: book.ts },
  };
  appendJsonl(exitsFile(), exit, { sync: true });
  return exit;
}

export function allPredictions() {
  return readJsonl(predictionsFile());
}
export function allFills() {
  return readJsonl(fillsFile());
}
export function allExits() {
  return readJsonl(exitsFile());
}

export function openPositions() {
  const exited = new Set(allExits().map((e) => e.prediction_id));
  return allFills().filter((f) => !exited.has(f.prediction_id));
}
