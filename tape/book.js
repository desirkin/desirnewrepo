// Live L2 order book for one symbol, fed by Kraken WS v2 book messages.
// Integrity: every update carries a CRC32 checksum of the top 10 levels;
// a mismatch means our book has drifted from the venue's and must be resynced.
import { crc32 } from '../lib/crc32.js';

export class OrderBook {
  constructor(symbol, depth) {
    this.symbol = symbol;
    this.depth = depth;
    this.bids = new Map(); // price(number) -> qty(number)
    this.asks = new Map();
    this.synced = false;
    this.lastUpdateTs = null;
    // Decimal places for checksum formatting, learned from the instrument
    // channel (price_increment / qty_increment). Until known, checksums are
    // reported as unverifiable rather than guessed.
    this.pricePrecision = null;
    this.qtyPrecision = null;
  }

  setPrecision(pricePrecision, qtyPrecision) {
    this.pricePrecision = pricePrecision;
    this.qtyPrecision = qtyPrecision;
  }

  applySnapshot(data) {
    this.bids.clear();
    this.asks.clear();
    for (const { price, qty } of data.bids ?? []) this.bids.set(price, qty);
    for (const { price, qty } of data.asks ?? []) this.asks.set(price, qty);
    this.synced = true;
    this.lastUpdateTs = Date.now();
  }

  // Returns { ok, computed, expected } — ok is null when the checksum could
  // not be verified (precision unknown), true/false otherwise.
  applyUpdate(data) {
    for (const { price, qty } of data.bids ?? []) {
      if (qty === 0) this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const { price, qty } of data.asks ?? []) {
      if (qty === 0) this.asks.delete(price);
      else this.asks.set(price, qty);
    }
    this.truncate();
    this.lastUpdateTs = Date.now();
    if (typeof data.checksum !== 'number') return { ok: null };
    const computed = this.checksum();
    if (computed === null) return { ok: null, expected: data.checksum };
    return { ok: computed === data.checksum, computed, expected: data.checksum };
  }

  // Kraken keeps the book at the subscribed depth: after updates, levels
  // beyond the depth on each side are dropped.
  truncate() {
    if (this.bids.size > this.depth) {
      for (const price of this.sortedBids().slice(this.depth).map((l) => l.price)) this.bids.delete(price);
    }
    if (this.asks.size > this.depth) {
      for (const price of this.sortedAsks().slice(this.depth).map((l) => l.price)) this.asks.delete(price);
    }
  }

  sortedBids() {
    return [...this.bids.entries()].map(([price, qty]) => ({ price, qty })).sort((a, b) => b.price - a.price);
  }

  sortedAsks() {
    return [...this.asks.entries()].map(([price, qty]) => ({ price, qty })).sort((a, b) => a.price - b.price);
  }

  bestBid() {
    return this.sortedBids()[0] ?? null;
  }

  bestAsk() {
    return this.sortedAsks()[0] ?? null;
  }

  mid() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask) return null;
    return (bid.price + ask.price) / 2;
  }

  // Kraken WS v2 checksum: for the top 10 asks (ascending) then top 10 bids
  // (descending), format price and qty to the instrument's precision, drop
  // the decimal point, strip leading zeros, concatenate everything, CRC32.
  checksum() {
    if (this.pricePrecision === null || this.qtyPrecision === null) return null;
    const fmt = (value, decimals) =>
      value
        .toFixed(decimals)
        .replace('.', '')
        .replace(/^0+/, '');
    let digest = '';
    for (const { price, qty } of this.sortedAsks().slice(0, 10)) {
      digest += fmt(price, this.pricePrecision) + fmt(qty, this.qtyPrecision);
    }
    for (const { price, qty } of this.sortedBids().slice(0, 10)) {
      digest += fmt(price, this.pricePrecision) + fmt(qty, this.qtyPrecision);
    }
    return crc32(digest);
  }

  desync() {
    this.synced = false;
    this.bids.clear();
    this.asks.clear();
  }

  toJSON() {
    return {
      symbol: this.symbol,
      synced: this.synced,
      lastUpdateTs: this.lastUpdateTs,
      bids: this.sortedBids(),
      asks: this.sortedAsks(),
    };
  }
}

// Decimal places implied by an increment like 0.01 -> 2, 1e-8 -> 8.
export function decimalsOf(increment) {
  if (!increment || increment <= 0) return null;
  const s = increment.toExponential();
  const [mantissa, exp] = s.split('e');
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').length;
  return Math.max(0, mantissaDecimals - Number(exp));
}
