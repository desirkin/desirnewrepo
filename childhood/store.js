// Candle store with the WALL built into its shape: replay code receives an
// AsOfView bound to a timestamp T, and every accessor on that view refuses
// the future. The full store is handed only to the labeler, afterward.
export class CandleStore {
  constructor(symbol, intervalSec, candles /* [[t,o,h,l,c,v],...] ascending */) {
    this.symbol = symbol;
    this.intervalSec = intervalSec;
    this.candles = candles;
  }

  // The only face replay code is allowed to hold.
  asOf(ts) {
    return new AsOfView(this, ts);
  }

  // Labeler-only: candles strictly after ts, up to horizonSec ahead.
  future(ts, horizonSec) {
    return this.candles.filter((c) => c[0] > ts && c[0] <= ts + horizonSec);
  }

  atOrBefore(ts) {
    let last = null;
    for (const c of this.candles) {
      if (c[0] > ts) break;
      last = c;
    }
    return last;
  }
}

export class WallViolation extends Error {}

export class AsOfView {
  #store;
  constructor(store, ts) {
    this.#store = store;
    this.ts = ts;
    this.symbol = store.symbol;
    this.intervalSec = store.intervalSec;
  }

  // Candles with timestamp <= T only. Asking beyond T throws — the future
  // is not merely filtered, it is unreachable from this object.
  candlesUpTo(ts = this.ts) {
    if (ts > this.ts) throw new WallViolation(`asOf(${this.ts}) asked for ${ts} — the future is walled off`);
    return this.#store.candles.filter((c) => c[0] <= ts);
  }

  last(n = 1) {
    const past = this.candlesUpTo();
    return past.slice(-n);
  }

  closeAt(minutesAgo = 0) {
    const target = this.ts - minutesAgo * 60;
    if (target > this.ts) throw new WallViolation('negative minutesAgo reaches the future');
    let last = null;
    for (const c of this.#store.candles) {
      if (c[0] > target) break;
      last = c;
    }
    return last ? last[4] : null;
  }
}

// Log return between two closes, null-safe.
export function retBetween(pNow, pThen) {
  if (!pNow || !pThen || pThen <= 0 || pNow <= 0) return null;
  return Math.log(pNow / pThen);
}

// MFE/MAE over a window of future candles relative to an entry price:
// max favorable excursion uses highs, max adverse uses lows, as percentages.
export function mfeMae(entry, futureCandles) {
  if (!entry || entry <= 0 || !futureCandles.length) return { mfe: null, mae: null };
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of futureCandles) {
    if (c[2] > hi) hi = c[2]; // high
    if (c[3] < lo) lo = c[3]; // low
  }
  return { mfe: ((hi - entry) / entry) * 100, mae: ((lo - entry) / entry) * 100 };
}
