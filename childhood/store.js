// Candle store with the WALL built into its shape, hardened by B-0A:
// - CLOSED-BAR semantics: a bar whose interval has not fully elapsed is
//   invisible. All visibility is judged by bar CLOSE time, because a bar's
//   high/low/close/volume are only knowable once it closes.
// - Replay code never holds the store: it consumes replayViews(), a forward
//   iterator yielding one closed bar + a wall-bound view at a time. The
//   future is not filtered away — it is structurally unreachable.
export class CandleStore {
  // coverageEndSec (B-0B.1 §1): the timestamp through which the SOURCE is
  // known to cover the market — not merely the last candle's close. For REST
  // data this defensibly extends to retrieval time (Kraken serves the full
  // series; an absent bar up to retrieval means no trades occurred, not that
  // the dataset ended). Defaults conservatively to the last candle's close.
  // "There were no trades" and "the dataset ended" are different facts and
  // are never confused.
  constructor(symbol, intervalSec, candles /* [[openTs,o,h,l,c,v],...] ascending */, { coverageEndSec = null } = {}) {
    this.symbol = symbol;
    this.intervalSec = intervalSec;
    this.candles = candles;
    this.coverageEndSec = coverageEndSec ?? (candles.length ? candles.at(-1)[0] + intervalSec : null);
  }

  // TRUE only when the source provably covers the ENTIRE interval
  // [ts, ts + horizonSec]. Outcome horizons that fail this are null.
  coversHorizon(ts, horizonSec) {
    return this.coverageEndSec !== null && ts + horizonSec <= this.coverageEndSec;
  }

  closeTs(i) {
    return this.candles[i][0] + this.intervalSec;
  }

  // The face handed to replay code: yields {replayTs, bar, view} where
  // replayTs is the bar's CLOSE time — the earliest moment its values were
  // knowable — and view walls off everything not closed by replayTs.
  *replayViews() {
    for (let i = 0; i < this.candles.length; i++) {
      const replayTs = this.closeTs(i);
      yield { replayTs, bar: this.candles[i], view: new AsOfView(this, replayTs) };
    }
  }

  asOf(ts) {
    return new AsOfView(this, ts);
  }

  // Labeler-only: bars that OPEN at or after ts (i.e. begin after the
  // decision moment) within horizonSec.
  future(ts, horizonSec) {
    return this.candles.filter((c) => c[0] >= ts && c[0] < ts + horizonSec);
  }

  // Last bar fully CLOSED by ts (closed-bar discipline for anchors too).
  atOrBefore(ts) {
    let last = null;
    for (const c of this.candles) {
      if (c[0] + this.intervalSec > ts) break;
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

  // Bars fully CLOSED by T only. An unfinished bar — even one that has
  // opened — does not exist yet from this view. Asking beyond T throws.
  candlesUpTo(ts = this.ts) {
    if (ts > this.ts) throw new WallViolation(`asOf(${this.ts}) asked for ${ts} — the future is walled off`);
    return this.#store.candles.filter((c) => c[0] + this.#store.intervalSec <= ts);
  }

  last(n = 1) {
    return this.candlesUpTo().slice(-n);
  }

  // Close of the last bar fully closed at (T - minutesAgo).
  closeAt(minutesAgo = 0) {
    if (minutesAgo < 0) throw new WallViolation('negative minutesAgo reaches the future');
    const target = this.ts - minutesAgo * 60;
    let last = null;
    for (const c of this.#store.candles) {
      if (c[0] + this.#store.intervalSec > target) break;
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

// MFE/MAE over a window of future candles relative to an entry price.
// LONG-ONLY DEFINITION (B-0B.1 §5, doctrine/CHILDHOOD.md):
//   MFE = max(0, maximum favorable % excursion ABOVE entry)
//   MAE = min(0, maximum adverse % excursion BELOW entry)
// A path that only rises has MAE = 0 (never a positive number); a path that
// only falls has MFE = 0 (never a negative number). Signed highest/lowest
// excursions are a different concept and are not called MFE/MAE here.
export function mfeMae(entry, futureCandles) {
  if (!entry || entry <= 0 || !futureCandles.length) return { mfe: null, mae: null };
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of futureCandles) {
    if (c[2] > hi) hi = c[2];
    if (c[3] < lo) lo = c[3];
  }
  return { mfe: Math.max(0, ((hi - entry) / entry) * 100), mae: Math.min(0, ((lo - entry) / entry) * 100) };
}
