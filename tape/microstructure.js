// MICRO-1 — DARK MICROSTRUCTURE SENSE.
//
// "MICROSTRUCTURE is a sense, not a strategy."
//
// This module OBSERVES live order flow, liquidity pressure, visible
// depletion/recovery and price response for a small bounded set of symbols
// (active stalking ∩ subscribed tape ∩ synchronized books). It writes
// append-only observations that the dark Memory mirror later canonicalizes.
// It has ZERO trading weight: no posture, stalking, ledger, cost or control
// module imports it, and nothing here can grant, score, or authorize.
//
// L2 HONESTY (non-negotiable): the book is AGGREGATE Level 2. A negative
// quantity change may be execution, cancellation, replacement or several
// orders at once — we cannot attribute it. Every liquidity-change metric
// here is therefore a PROXY and is named as one (visible*, *Proxy), with
// attribution AGGREGATE_L2_UNATTRIBUTED carried in the observation.
//
// TIMING HONESTY: trade records carry Kraken timestamps; book samples carry
// LOCAL application time. Exact causal trade→book sequencing is not
// exchange-time truth; the limitation is carried in provenance.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonl } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';
import { bookFeatures } from './features.js';

export const MICRO_VERSION = 'MICRO-1';

// Every per-symbol structure is bounded by these documented limits.
export const MICRO_LIMITS = Object.freeze({
  maxTrackedSymbols: 12, // hard cap on simultaneously tracked symbols
  tradeHorizonMs: 300_000, // longest flow window; older trades pruned
  maxTradesPerSymbol: 4000, // ring cap; overflow drops oldest and is counted
  sampleMinIntervalMs: 500, // book sampled at most twice per second
  sampleHorizonMs: 90_000, // sample history horizon (covers 60s windows)
  maxBookSamplesPerSymbol: 240, // ring cap (240 × ≥500ms ≥ 120s)
  maxCompletedEpisodesPerSymbol: 12, // bounded completed-episode memory
  episodeMaxAgeMs: 120_000, // an unrecovered episode expires (milestones stay honest nulls)
  graceMs: 30_000, // symbol leaving the tracking set keeps state this long, then discarded
  emitIntervalMs: 5_000, // one observation per tracked symbol per ~5s
  maxObservationsPerMinute: 144, // hard emission cap: 12 symbols × 12/min
});

export const FLOW_WINDOWS_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);
export const RESPONSE_WINDOWS_MS = Object.freeze([5_000, 15_000, 60_000]);
export const DEPTH_BANDS = Object.freeze(['top', '5bps', '10bps', '25bps']);
// depletion/recovery episodes are measured on ONE defined band, per side
export const EPISODE_BAND = '10bps';
// a depletion episode opens when one sample-to-sample drop removes at least
// this fraction of a band that held at least this much visible notional —
// definitions of the OBSERVATION, not trading thresholds
export const DEPLETION_MIN_FRACTION = 0.35;
export const DEPLETION_MIN_NOTIONAL_USD = 2_000;
export const L2_ATTRIBUTION = 'AGGREGATE_L2_UNATTRIBUTED';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------
// PURE METRICS (exported for deterministic tests)
// ---------------------------------------------------------------------

// Aggressive flow over one rolling window, from direct Kraken taker side
// (side === 'buy' means aggressive/taker buying — kept, never re-inferred).
export function flowWindow(trades, windowMs, now) {
  const from = now - windowMs;
  let buyQty = 0, sellQty = 0, buyUsd = 0, sellUsd = 0, buyN = 0, sellN = 0;
  for (const t of trades) {
    if (t.ts < from || t.ts > now) continue;
    if (t.side === 'buy') { buyQty += t.qty; buyUsd += t.notionalUsd; buyN++; }
    else { sellQty += t.qty; sellUsd += t.notionalUsd; sellN++; }
  }
  const totalQty = buyQty + sellQty;
  const totalUsd = buyUsd + sellUsd;
  return {
    aggressiveBuyQty: buyQty,
    aggressiveSellQty: sellQty,
    aggressiveBuyNotionalUsd: buyUsd,
    aggressiveSellNotionalUsd: sellUsd,
    aggressiveBuyTradeCount: buyN,
    aggressiveSellTradeCount: sellN,
    signedQty: buyQty - sellQty,
    signedNotionalUsd: buyUsd - sellUsd,
    quantityImbalance: totalQty > 0 ? (buyQty - sellQty) / totalQty : null,
    notionalImbalance: totalUsd > 0 ? (buyUsd - sellUsd) / totalUsd : null,
  };
}

// The sample at-or-before (now - windowMs): the window's starting state.
// Insufficient history (no sample old enough) is NULL, never zero.
const startSlackMs = 1_500;
function sampleAt(samples, windowMs, now) {
  const cutoff = now - windowMs + startSlackMs;
  let candidate = null;
  for (const s of samples) {
    if (s.ts <= cutoff) candidate = s;
    else break;
  }
  return candidate;
}

// Mid-price response over a completed window, with the flow that rode it.
// UNKNOWN (null) until enough history exists — insufficient history is
// never zero. priceResponsePerSignedNotional is HISTORICAL MEASURED
// RESPONSE (pct per $1M signed notional) — not alpha, edge or prediction.
export function priceResponse(samples, trades, windowMs, now) {
  const start = sampleAt(samples, windowMs, now);
  const end = samples.length ? samples[samples.length - 1] : null;
  if (!start || !end || !fin(start.mid) || !fin(end.mid) || start.mid <= 0) return null;
  const flow = flowWindow(trades, windowMs, now);
  const midReturnPct = ((end.mid - start.mid) / start.mid) * 100;
  return {
    windowMs,
    startMid: start.mid,
    endMid: end.mid,
    midReturnPct,
    signedQty: flow.signedQty,
    signedNotionalUsd: flow.signedNotionalUsd,
    buyNotionalUsd: flow.aggressiveBuyNotionalUsd,
    sellNotionalUsd: flow.aggressiveSellNotionalUsd,
    priceResponsePerSignedNotional:
      Math.abs(flow.signedNotionalUsd) >= 1 ? midReturnPct / (flow.signedNotionalUsd / 1e6) : null,
  };
}

// Spread behavior over a window. Widening/compression magnitudes are the
// positive parts of the change — measurements, not judgments.
export function spreadDynamics(samples, windowMs, now) {
  const start = sampleAt(samples, windowMs, now);
  const end = samples.length ? samples[samples.length - 1] : null;
  if (!start || !end || !fin(start.spreadBps) || !fin(end.spreadBps)) return null;
  const change = end.spreadBps - start.spreadBps;
  return {
    windowMs,
    spreadBps: end.spreadBps,
    spreadChangeBps: change,
    spreadWideningMagnitude: Math.max(0, change),
    spreadCompressionMagnitude: Math.max(0, -change),
  };
}

// Depth pressure per labeled band over a window. Depletion percentages are
// VISIBLE (aggregate L2) — never "cancellation volume".
export function depthDynamics(samples, windowMs, now, band) {
  const start = sampleAt(samples, windowMs, now);
  const end = samples.length ? samples[samples.length - 1] : null;
  const s0 = start?.depth?.[band];
  const s1 = end?.depth?.[band];
  if (!s0 || !s1 || !fin(s0.bid) || !fin(s0.ask) || !fin(s1.bid) || !fin(s1.ask)) return null;
  const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
  const bidPct = pct(s0.bid, s1.bid);
  const askPct = pct(s0.ask, s1.ask);
  const obi0 = start.obi?.[band];
  const obi1 = end.obi?.[band];
  return {
    band,
    windowMs,
    bidDepthUsd: s1.bid,
    askDepthUsd: s1.ask,
    bidDepthDeltaUsd: s1.bid - s0.bid,
    askDepthDeltaUsd: s1.ask - s0.ask,
    bidDepthChangePct: bidPct,
    askDepthChangePct: askPct,
    visibleBidDepletionPct: bidPct === null ? null : Math.max(0, -bidPct),
    visibleAskDepletionPct: askPct === null ? null : Math.max(0, -askPct),
    obi: fin(obi1) ? obi1 : null,
    obiDelta: fin(obi0) && fin(obi1) ? obi1 - obi0 : null,
  };
}

// Band coverage: COMPLETE when the subscribed levels extend past the band
// boundary on that side (the band is fully visible); PARTIAL when the
// subscribed book ends inside the band — a lower-bound observation.
export function bandCoverage(levels, mid, bps, side) {
  if (!Array.isArray(levels) || !levels.length || !fin(mid) || mid <= 0) return null;
  const limit = side === 'bid' ? mid * (1 - bps / 1e4) : mid * (1 + bps / 1e4);
  const deepest = levels[levels.length - 1].price;
  const extendsPast = side === 'bid' ? deepest < limit : deepest > limit;
  return extendsPast ? 'COMPLETE' : 'PARTIAL';
}

// Median helper for recovery comparison (small bounded arrays only).
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Recovery asymmetry across completed episodes with a 50% milestone on BOTH
// sides. Positive value = bid side recovers FASTER (smaller ms) than ask.
// Not comparable => 'UNKNOWN'. Never an invented zero.
export function recoveryAsymmetry(completedEpisodes) {
  const bid = completedEpisodes.filter((e) => e.side === 'bid' && fin(e.depthRecovery50Ms)).map((e) => e.depthRecovery50Ms);
  const ask = completedEpisodes.filter((e) => e.side === 'ask' && fin(e.depthRecovery50Ms)).map((e) => e.depthRecovery50Ms);
  if (!bid.length || !ask.length) return 'UNKNOWN';
  const b = median(bid);
  const a = median(ask);
  if (!fin(b) || !fin(a) || a + b <= 0) return 'UNKNOWN';
  return {
    bidRecovery50MsMedian: b,
    askRecovery50MsMedian: a,
    bidEpisodes: bid.length,
    askEpisodes: ask.length,
    // (ask - bid)/(ask + bid): +1 = bid side recovers much faster, -1 = ask
    value: (a - b) / (a + b),
  };
}

// ABSORPTION_PROXY — an observationally-defined coincidence of measured
// facts, never a confirmation and never a trade signal. All the underlying
// facts are preserved beside it so a future Brain can DISAGREE with it.
// Definitions (documented in doctrine/MICROSTRUCTURE.md):
//   strong flow: |notionalImbalance| ≥ 0.6 AND dominant-side notional ≥ $25k
//   in the 60s window; small response: |midReturnPct(60s)| ≤ 0.05%;
//   opposing visible depth persists: its 60s change ≥ -10% (EPISODE_BAND);
//   prerequisites: fresh book, COMPLETE coverage on the opposing side band.
export const ABSORPTION_MIN_IMBALANCE = 0.6;
export const ABSORPTION_MIN_NOTIONAL_USD = 25_000;
export const ABSORPTION_MAX_RESPONSE_PCT = 0.05;
export const ABSORPTION_MAX_OPPOSING_DEPLETION_PCT = 10;
export function absorptionProxy({ flow60, response60, depth60, bookFresh, opposingCoverage }) {
  if (!bookFresh) return { state: 'DEGRADED', reason: 'book stale' };
  if (!flow60 || !response60 || !depth60) return { state: 'UNAVAILABLE', reason: 'insufficient history' };
  const imb = flow60.notionalImbalance;
  if (imb === null) return { state: 'UNAVAILABLE', reason: 'no aggressive flow in window' };
  const buying = imb >= ABSORPTION_MIN_IMBALANCE && flow60.aggressiveBuyNotionalUsd >= ABSORPTION_MIN_NOTIONAL_USD;
  const selling = imb <= -ABSORPTION_MIN_IMBALANCE && flow60.aggressiveSellNotionalUsd >= ABSORPTION_MIN_NOTIONAL_USD;
  if (!buying && !selling) return { state: 'NOT_PRESENT', reason: 'flow below proxy definition' };
  const cov = buying ? opposingCoverage.ask : opposingCoverage.bid;
  if (cov !== 'COMPLETE') return { state: 'UNAVAILABLE', reason: `opposing ${EPISODE_BAND} band coverage ${cov ?? 'unknown'}` };
  const responseSmall = Math.abs(response60.midReturnPct) <= ABSORPTION_MAX_RESPONSE_PCT;
  const opposingChangePct = buying ? depth60.askDepthChangePct : depth60.bidDepthChangePct;
  const opposingPersists = opposingChangePct !== null && opposingChangePct >= -ABSORPTION_MAX_OPPOSING_DEPLETION_PCT;
  if (responseSmall && opposingPersists) {
    return {
      state: 'PRESENT',
      side: buying ? 'aggressive-buying-absorbed-like' : 'aggressive-selling-absorbed-like',
      // the measured facts the proxy stands on — preserved, not collapsed
      notionalImbalance60s: imb,
      signedNotionalUsd60s: flow60.signedNotionalUsd,
      midReturnPct60s: response60.midReturnPct,
      opposingDepthChangePct60s: opposingChangePct,
      opposingCoverage: cov,
      attribution: L2_ATTRIBUTION,
    };
  }
  return {
    state: 'NOT_PRESENT',
    reason: responseSmall ? 'opposing visible depth depleted' : 'price responded',
    midReturnPct60s: response60.midReturnPct,
    opposingDepthChangePct60s: opposingChangePct,
  };
}

// ---------------------------------------------------------------------
// STALKING READ (guarded, read-only — a corrupt state file yields the
// empty set and NEVER throws into the tape)
// ---------------------------------------------------------------------
export function readStalkingCoins(now = Date.now()) {
  try {
    const file = path.join(dataDir(), 'state', 'stalking.json');
    if (!existsSync(file)) return new Set();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const live = new Set();
    for (const [coin, entry] of Object.entries(raw)) {
      if (entry && typeof entry.expiresMs === 'number' && entry.expiresMs > now) live.add(coin);
    }
    return live;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------
// TRACKER — bounded per-symbol state, failure-isolated
// ---------------------------------------------------------------------
export class MicrostructureTracker {
  constructor({ bookStaleMs = 15_000, limits = MICRO_LIMITS, log = () => {} } = {}) {
    this.bookStaleMs = bookStaleMs;
    this.limits = limits;
    this.log = log;
    this.symbols = new Map(); // symbol -> per-symbol state
    this.failed = new Map(); // symbol -> last isolated error message
    this.isolatedErrors = 0;
    this.droppedTrades = 0;
    this.observationsBuilt = 0;
  }

  #fresh(symbol, now) {
    return {
      symbol,
      leftAt: null, // set when the symbol leaves the eligible set (grace)
      trades: [], // {ts, side, qty, price, notionalUsd} — Kraken ts, pruned+capped
      samples: [], // {ts(local), mid, spreadBps, depth, obi, coverage} — capped
      lastSampleTs: 0,
      activeEpisodes: { bid: null, ask: null }, // one per side, EPISODE_BAND only
      completedEpisodes: [], // capped ring of finished episodes
      trackedSince: now,
    };
  }

  // Tracking set = ACTIVE STALKING ∩ SUBSCRIBED ∩ SYNCED, computed by the
  // caller (the tape runner owns those facts). Enforces the tracked cap
  // deterministically and applies the documented grace before discarding.
  setTrackingSet(trackingSet, now = Date.now()) {
    const wanted = [...trackingSet].sort().slice(0, this.limits.maxTrackedSymbols);
    const wantedSet = new Set(wanted);
    for (const s of wanted) {
      const st = this.symbols.get(s);
      if (st) st.leftAt = null; // back in the set: grace cancelled
      else if (this.symbols.size < this.limits.maxTrackedSymbols) {
        this.symbols.set(s, this.#fresh(s, now));
        this.failed.delete(s); // a re-tracked symbol gets a clean slate
      }
    }
    for (const [s, st] of this.symbols) {
      if (wantedSet.has(s)) continue;
      if (st.leftAt === null) st.leftAt = now;
      else if (now - st.leftAt > this.limits.graceMs) this.symbols.delete(s); // process-local state discarded; durable Memory keeps what was written
    }
  }

  tracked() {
    return [...this.symbols.keys()].filter((s) => this.symbols.get(s).leftAt === null && !this.failed.has(s));
  }

  #isolate(symbol, err) {
    this.isolatedErrors++;
    this.failed.set(symbol, err?.message ?? String(err));
    this.log(`MICRO tracker isolated ${symbol} (tape unaffected): ${err?.message ?? err}`);
  }

  onTrade(symbol, { ts, side, qty, price }, now = Date.now()) {
    const st = this.symbols.get(symbol);
    if (!st || this.failed.has(symbol)) return;
    try {
      // non-finite input is refused — never stored, never zeroed
      if (!fin(ts) || !fin(qty) || !fin(price) || qty <= 0 || price <= 0) return;
      if (side !== 'buy' && side !== 'sell') return;
      st.trades.push({ ts, side, qty, price, notionalUsd: price * qty });
      const cutoff = now - this.limits.tradeHorizonMs;
      while (st.trades.length && st.trades[0].ts < cutoff) st.trades.shift();
      while (st.trades.length > this.limits.maxTradesPerSymbol) {
        st.trades.shift();
        this.droppedTrades++;
      }
    } catch (err) {
      this.#isolate(symbol, err);
    }
  }

  onBook(symbol, book, now = Date.now()) {
    const st = this.symbols.get(symbol);
    if (!st || this.failed.has(symbol)) return;
    try {
      if (!book?.synced) return;
      if (now - st.lastSampleTs < this.limits.sampleMinIntervalMs) return;
      const bf = bookFeatures(book);
      if (!bf) return;
      st.lastSampleTs = now;
      const bids = book.sortedBids();
      const asks = book.sortedAsks();
      const coverage = {};
      for (const bps of [5, 10, 25]) {
        coverage[`${bps}bps`] = {
          bid: bandCoverage(bids, bf.mid, bps, 'bid'),
          ask: bandCoverage(asks, bf.mid, bps, 'ask'),
        };
      }
      const sample = { ts: now, mid: bf.mid, spreadBps: bf.spreadBps, depth: bf.depthUsd, obi: bf.obi, coverage };
      st.samples.push(sample);
      const cutoff = now - this.limits.sampleHorizonMs;
      while (st.samples.length && st.samples[0].ts < cutoff) st.samples.shift();
      while (st.samples.length > this.limits.maxBookSamplesPerSymbol) st.samples.shift();
      this.#episodeStep(st, sample, now);
    } catch (err) {
      this.#isolate(symbol, err);
    }
  }

  // Visible depletion/recovery episodes on EPISODE_BAND, one per side.
  // "Recovery" is a DEPTH RECOVERY PROXY: visible aggregate depth returned;
  // it does not prove the same order, maker or provider came back.
  #episodeStep(st, sample, now) {
    const prev = st.samples.length >= 2 ? st.samples[st.samples.length - 2] : null;
    for (const side of ['bid', 'ask']) {
      const active = st.activeEpisodes[side];
      const depthNow = sample.depth?.[EPISODE_BAND]?.[side];
      if (!fin(depthNow)) continue;
      if (active) {
        const recovered = depthNow - active.postDepletionDepth;
        if (active.depthRecovery50Ms === null && recovered >= 0.5 * active.depletedAmount) {
          active.depthRecovery50Ms = now - active.depletionTs;
        }
        if (recovered >= 0.9 * active.depletedAmount) {
          active.depthRecovery90Ms = now - active.depletionTs;
          this.#closeEpisode(st, side, 'RECOVERED_90');
        } else if (now - active.depletionTs > this.limits.episodeMaxAgeMs) {
          this.#closeEpisode(st, side, 'EXPIRED'); // unreached milestones stay null — honest, not zero
        }
        continue;
      }
      const depthPrev = prev?.depth?.[EPISODE_BAND]?.[side];
      if (!fin(depthPrev) || depthPrev < DEPLETION_MIN_NOTIONAL_USD) continue;
      const drop = depthPrev - depthNow;
      if (drop / depthPrev >= DEPLETION_MIN_FRACTION) {
        st.activeEpisodes[side] = {
          side,
          band: EPISODE_BAND,
          depletionTs: now,
          preDepletionDepth: depthPrev,
          postDepletionDepth: depthNow,
          depletedAmount: drop,
          coverage: sample.coverage?.[EPISODE_BAND]?.[side] ?? null,
          depthRecovery50Ms: null,
          depthRecovery90Ms: null,
          attribution: L2_ATTRIBUTION,
        };
      }
    }
  }

  #closeEpisode(st, side, outcome) {
    const e = st.activeEpisodes[side];
    if (!e) return;
    st.activeEpisodes[side] = null;
    st.completedEpisodes.push({ ...e, outcome, closedTs: Date.now() });
    while (st.completedEpisodes.length > this.limits.maxCompletedEpisodesPerSymbol) st.completedEpisodes.shift();
  }

  // Build one bounded observation for a tracked symbol. Book-derived
  // measurements degrade honestly with book age; insufficient history is
  // UNKNOWN, never zero. Never throws into the tape.
  observe(symbol, book, coin, now = Date.now()) {
    const st = this.symbols.get(symbol);
    if (!st || this.failed.has(symbol)) return null;
    try {
      const bookAgeMs = book?.lastUpdateTs != null ? now - book.lastUpdateTs : null;
      const bookFresh = book?.synced === true && bookAgeMs !== null && bookAgeMs <= this.bookStaleMs;
      const flow = {};
      for (const w of FLOW_WINDOWS_MS) flow[`${w / 1000}s`] = flowWindow(st.trades, w, now);
      const response = {};
      for (const w of RESPONSE_WINDOWS_MS) {
        const r = bookFresh ? priceResponse(st.samples, st.trades, w, now) : null;
        response[`${w / 1000}s`] = r ?? (bookFresh ? 'UNKNOWN_INSUFFICIENT_HISTORY' : 'STALE');
      }
      const spread = bookFresh ? spreadDynamics(st.samples, 60_000, now) : null;
      const depth = {};
      for (const band of DEPTH_BANDS) {
        const d = bookFresh ? depthDynamics(st.samples, 60_000, now, band) : null;
        depth[band] = d ?? (bookFresh ? 'UNKNOWN_INSUFFICIENT_HISTORY' : 'STALE');
      }
      const latest = st.samples.length ? st.samples[st.samples.length - 1] : null;
      const coverage = latest?.coverage ?? null;
      const asym = recoveryAsymmetry(st.completedEpisodes);
      const proxy = absorptionProxy({
        flow60: flow['60s'],
        response60: typeof response['60s'] === 'object' ? response['60s'] : null,
        depth60: typeof depth[EPISODE_BAND] === 'object' ? depth[EPISODE_BAND] : null,
        bookFresh,
        opposingCoverage: coverage?.[EPISODE_BAND] ?? {},
      });
      this.observationsBuilt++;
      return {
        ts: nowIso(),
        trackerVersion: MICRO_VERSION,
        coin,
        symbol,
        bookAgeMs,
        bookState: bookFresh ? 'FRESH' : 'STALE',
        flow,
        priceResponse: response,
        spread: spread ?? (bookFresh ? 'UNKNOWN_INSUFFICIENT_HISTORY' : 'STALE'),
        depth,
        coverage,
        episodes: {
          activeBid: st.activeEpisodes.bid,
          activeAsk: st.activeEpisodes.ask,
          recentlyCompleted: st.completedEpisodes.slice(-3),
        },
        recoveryAsymmetry50: asym,
        absorptionProxy: proxy,
        limitations: [L2_ATTRIBUTION, 'LOCAL_BOOK_APPLICATION_CLOCK'],
        provenance: {
          tradeChannel: 'kraken-ws-v2 trade (direct taker side)',
          bookChannel: 'kraken-ws-v2 book (aggregate L2)',
          tradeClock: 'kraken timestamps',
          bookClock: 'local application time',
          subscribedDepth: book?.depth ?? null,
          flowWindowsMs: [...FLOW_WINDOWS_MS],
          responseWindowsMs: [...RESPONSE_WINDOWS_MS],
          episodeBand: EPISODE_BAND,
          depletionMinFraction: DEPLETION_MIN_FRACTION,
          depletionMinNotionalUsd: DEPLETION_MIN_NOTIONAL_USD,
        },
      };
    } catch (err) {
      this.#isolate(symbol, err);
      return null;
    }
  }

  health() {
    return {
      status: this.failed.size || this.isolatedErrors ? 'DEGRADED' : 'HEALTHY',
      trackedCount: this.tracked().length,
      failedSymbols: [...this.failed.keys()],
      isolatedErrors: this.isolatedErrors,
      droppedTrades: this.droppedTrades,
      observationsBuilt: this.observationsBuilt,
    };
  }
}

// Append one observation to the MICRO stream the dark mirror tails.
export function writeMicroObservation(obs) {
  appendJsonl(path.join(dataDir(), 'micro', 'observations.jsonl'), obs);
}
