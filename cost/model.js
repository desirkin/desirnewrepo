// Execution Cost Model v0 — Gate Zero.
// If we can't price the strike from live, verified tape, the strike doesn't
// exist: any doubt returns UNAVAILABLE, never an estimate.
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentBook, readTapeStatus, TAPE_STATES } from '../tape/store.js';

const evaluationsFile = () => path.join(dataDir(), 'cost', 'evaluations.jsonl');

// Walk one side of the book spending `sizeUsd` (asks, for a buy).
// Returns null-safe result; exhausted=true means the visible book couldn't
// absorb the size — that rung is unpriceable, not extrapolated.
export function walkAsksForUsd(asks, sizeUsd) {
  let remainingUsd = sizeUsd;
  let baseQty = 0;
  let levelsUsed = 0;
  for (const { price, qty } of asks) {
    const levelUsd = price * qty;
    levelsUsed++;
    if (levelUsd >= remainingUsd) {
      baseQty += remainingUsd / price;
      remainingUsd = 0;
      break;
    }
    baseQty += qty;
    remainingUsd -= levelUsd;
  }
  if (remainingUsd > 1e-9) return { exhausted: true, baseQty, levelsUsed };
  return { exhausted: false, baseQty, levelsUsed, avgPrice: sizeUsd / baseQty };
}

// Walk the bid side selling `baseQty`.
export function walkBidsForQty(bids, baseQty) {
  let remainingQty = baseQty;
  let proceedsUsd = 0;
  let levelsUsed = 0;
  for (const { price, qty } of bids) {
    levelsUsed++;
    if (qty >= remainingQty) {
      proceedsUsd += remainingQty * price;
      remainingQty = 0;
      break;
    }
    proceedsUsd += qty * price;
    remainingQty -= qty;
  }
  if (remainingQty > 1e-12) return { exhausted: true, proceedsUsd, levelsUsed };
  return { exhausted: false, proceedsUsd, levelsUsed, avgPrice: proceedsUsd / baseQty };
}

function unavailable(reason) {
  return { status: 'UNAVAILABLE', reason: `UNAVAILABLE — ${reason}` };
}

// Immediate round trip priced off one book: buy sizeUsd walking asks, sell the
// acquired qty walking bids, taker fee both directions. The friction number is
// what the market charges you for being wrong about nothing.
export function priceRoundTrip(book, sizeUsd, fees) {
  const entry = walkAsksForUsd(book.asks, sizeUsd);
  if (entry.exhausted) return { status: 'UNAVAILABLE_DEPTH', side: 'entry', levelsUsed: entry.levelsUsed };
  const exit = walkBidsForQty(book.bids, entry.baseQty);
  if (exit.exhausted) return { status: 'UNAVAILABLE_DEPTH', side: 'exit', levelsUsed: exit.levelsUsed };

  const entryFeeUsd = sizeUsd * fees.taker;
  const trueEntryCostUsd = sizeUsd + entryFeeUsd;
  const exitFeeUsd = exit.proceedsUsd * fees.taker;
  const trueExitValueUsd = exit.proceedsUsd - exitFeeUsd;
  const frictionUsd = trueEntryCostUsd - trueExitValueUsd;
  const frictionBps = (frictionUsd / sizeUsd) * 1e4;
  // The mid must move up enough that exit proceeds grow by frictionUsd.
  const breakEvenMovePct = (frictionUsd / exit.proceedsUsd) * 100;

  const mid = (book.bids[0].price + book.asks[0].price) / 2;
  const spreadBps = ((book.asks[0].price - book.bids[0].price) / mid) * 1e4;

  // Maker-path variant: fee-at-maker, fill-at-touch assumed on both legs.
  // Fills are NOT guaranteed — flagged OPTIMISTIC, never the default truth.
  const makerFrictionUsd = sizeUsd * fees.maker * 2 - sizeUsd * (spreadBps / 1e4);
  const makerBreakEvenMovePct = (makerFrictionUsd / sizeUsd) * 100;

  return {
    status: 'OK',
    sizeUsd,
    entryAvgPrice: entry.avgPrice,
    entryLevelsUsed: entry.levelsUsed,
    baseQty: entry.baseQty,
    entryFeeUsd,
    trueEntryCostUsd,
    exitAvgPrice: exit.avgPrice,
    exitLevelsUsed: exit.levelsUsed,
    exitProceedsUsd: exit.proceedsUsd,
    exitFeeUsd,
    trueExitValueUsd,
    estimatedRoundTripFrictionUsd: frictionUsd,
    estimatedRoundTripFrictionBps: frictionBps,
    breakEvenMovePct,
    mid,
    spreadBps,
    makerPath: {
      flag: 'OPTIMISTIC',
      assumption: 'fill-at-touch both legs, maker fee — fill not guaranteed',
      frictionUsd: makerFrictionUsd,
      frictionBps: (makerFrictionUsd / sizeUsd) * 1e4,
      breakEvenMovePct: makerBreakEvenMovePct,
    },
  };
}

// Public entry: cost evaluation for (coin, buy, sizeUsd) from the live tape.
// Refuses when the tape is DEGRADED/OFFLINE or the book is stale/missing.
export function evaluateCost(coin, sizeUsd, { ladder = false } = {}) {
  const config = loadConfig();
  if (!config.universe.includes(coin)) return unavailable(`${coin} not in universe`);

  const status = readTapeStatus();
  if (!status) return unavailable('NO TRADE (no tape status — is the tape running?)');
  if (status.state !== TAPE_STATES.LIVE) {
    return unavailable(`NO TRADE (tape ${status.state} — DATA INTEGRITY)`);
  }
  const statusAgeSec = (Date.now() - status.tsMs) / 1000;
  if (statusAgeSec > config.cost.maxBookAgeSec) {
    return unavailable(`NO TRADE (tape status stale ${statusAgeSec.toFixed(1)}s)`);
  }

  const book = readCurrentBook(coin);
  if (!book || !book.synced) return unavailable(`NO TRADE (no synced book for ${coin})`);
  const bookAgeSec = (Date.now() - book.tsMs) / 1000;
  if (bookAgeSec > config.cost.maxBookAgeSec) {
    return unavailable(`NO TRADE (book for ${coin} stale ${bookAgeSec.toFixed(1)}s)`);
  }

  const fees = config.fees[config.venue];
  const sizes = ladder ? config.cost.sizeLadderUsd : [sizeUsd];
  const rungs = sizes.map((usd) => priceRoundTrip(book, usd, fees));

  const evaluation = {
    ts: nowIso(),
    coin,
    side: 'buy',
    requestedSizeUsd: sizeUsd,
    ladder,
    bookRef: { ts: book.ts, ageSec: bookAgeSec },
    feeSchedule: { venue: config.venue, version: config.fees.version, ...fees },
    rungs,
  };
  appendJsonl(evaluationsFile(), evaluation);
  return { status: 'OK', ...evaluation };
}
