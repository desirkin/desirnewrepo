// v0 tape features computed per snapshot. All derived strictly from observed
// book/trade data — no interpolation, no invention. Missing inputs -> null.

const DEPTH_BANDS_BPS = [5, 10, 25];

// USD notional resting within `bps` of mid on one side of the book.
function bandNotional(levels, mid, bps, side) {
  const limit = side === 'bid' ? mid * (1 - bps / 1e4) : mid * (1 + bps / 1e4);
  let notional = 0;
  for (const { price, qty } of levels) {
    if (side === 'bid' ? price < limit : price > limit) break;
    notional += price * qty;
  }
  return notional;
}

function imbalance(bid, ask) {
  const total = bid + ask;
  if (total <= 0) return null;
  return (bid - ask) / total;
}

// book: OrderBook instance. Returns null until both sides exist.
export function bookFeatures(book) {
  const bestBid = book.bestBid();
  const bestAsk = book.bestAsk();
  if (!bestBid || !bestAsk) return null;
  const mid = (bestBid.price + bestAsk.price) / 2;
  const spreadBps = ((bestAsk.price - bestBid.price) / mid) * 1e4;

  const bids = book.sortedBids();
  const asks = book.sortedAsks();
  const topBidNotional = bestBid.price * bestBid.qty;
  const topAskNotional = bestAsk.price * bestAsk.qty;

  const depth = {
    top: { bid: topBidNotional, ask: topAskNotional },
  };
  const obi = {
    top: imbalance(topBidNotional, topAskNotional),
  };
  for (const bps of DEPTH_BANDS_BPS) {
    const bid = bandNotional(bids, mid, bps, 'bid');
    const ask = bandNotional(asks, mid, bps, 'ask');
    depth[`${bps}bps`] = { bid, ask };
    obi[`${bps}bps`] = imbalance(bid, ask);
  }

  return {
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    bestBidQty: bestBid.qty,
    bestAskQty: bestAsk.qty,
    mid,
    spreadBps,
    depthUsd: depth,
    obi,
  };
}

// Rolling trade tape for one coin: aggressive (taker-side) imbalance and CVD.
export class TradeFlow {
  constructor() {
    this.trades = []; // { ts(ms), side: 'buy'|'sell', qty, price }
    this.cvd = 0; // cumulative volume delta in base units since process start
  }

  add({ ts, side, qty, price }) {
    this.trades.push({ ts, side, qty, price });
    this.cvd += side === 'buy' ? qty : -qty;
    const cutoff = Date.now() - 5 * 60_000;
    while (this.trades.length && this.trades[0].ts < cutoff) this.trades.shift();
  }

  imbalanceOver(windowMs, now = Date.now()) {
    let buy = 0;
    let sell = 0;
    for (const t of this.trades) {
      if (t.ts < now - windowMs) continue;
      if (t.side === 'buy') buy += t.qty;
      else sell += t.qty;
    }
    const total = buy + sell;
    if (total <= 0) return null;
    return (buy - sell) / total;
  }

  features(now = Date.now()) {
    return {
      tradeImbalance15s: this.imbalanceOver(15_000, now),
      tradeImbalance1m: this.imbalanceOver(60_000, now),
      tradeImbalance5m: this.imbalanceOver(300_000, now),
      cvd: this.cvd,
    };
  }
}
