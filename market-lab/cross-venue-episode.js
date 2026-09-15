// STRATEGY 6 / 7 WIRING (SHADOW_ONLY, 2026-09-15) — the PURE episode assembler that turns the new live senses into the exact
// episode objects the IFR and SDR detectors consume. This is the seam between the senses (Kraken spot / Coinbase / Binance
// public books, the Kraken-Futures public stream) and the pure detectors: it never fires, orders, or reaches the Judge — it
// only shapes receipt-time-ordered facts into an episode. Two honesty rules travel through here:
//   - the Binance USD reference is FROZEN-BASIS + STABLECOIN-HEALTH GATED: an unhealthy USDT peg yields a null USD reference,
//     which makes the IFR episode INPUTS_UNAVAILABLE (fail-closed) — a de-peg never masquerades as a Kraken-only flush;
//   - OI contraction is computed ONLY between two readings in the SAME verified native unit (CONTRACTS); a unit mismatch or
//     an unverified unit yields null contraction, which makes SDR refuse (NO_VERIFIED_OI_CONTRACTION), never a guess.
// Pure and deterministic (no clock, I/O, randomness); imports only the pure detector helpers and the Binance basis gate.
import { usdBasisFromUsdt } from './providers/binance.js';

export const CROSS_VENUE_EPISODE_VERSION = 'cross-venue-episode-1';
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const pos = (x) => finite(x) && x > 0;
const round = (x, d = 4) => (finite(x) ? Number(x.toFixed(d)) : null);

// A venue reference for IFR: a USD-basis mid + window low. Kraken and Coinbase quote USD directly; Binance quotes USDT and
// passes through the frozen-basis health gate, so an unhealthy peg returns { usdMid: null } and the reference drops out.
export function usdReference({ venue, quote, mid, windowLow = null, stablecoinHealth = null }) {
  if (quote === 'USDT') {
    const g = usdBasisFromUsdt(mid, stablecoinHealth);
    const gl = windowLow !== null ? usdBasisFromUsdt(windowLow, stablecoinHealth) : { usd: null };
    return { venue, usdMid: g.usd, usdWindowLow: gl.usd, stablecoinHealthy: g.healthy, stablecoinReason: g.reason };
  }
  return { venue, usdMid: pos(mid) ? mid : null, usdWindowLow: pos(windowLow) ? windowLow : null, stablecoinHealthy: true, stablecoinReason: null };
}

// Assemble the IFR episode. `references` is the ordered [coinbase, binance] set of usdReference() results; a null usdMid
// (absent venue OR an unhealthy stablecoin basis) flows straight into referenceMids, where the detector fails closed.
export function assembleIsolatedFlushEpisode({ canonicalCoin = null, decisionKnownAtTs = null, kraken = {}, references = [], secondWaveAbsorbed = false, localLowHeld = false } = {}) {
  const refs = references.slice(0, 2);
  return Object.freeze({
    canonicalCoin, decisionKnownAtTs,
    preFlushReferenceMid: pos(kraken.preFlushReferenceMid) ? kraken.preFlushReferenceMid : undefined,
    krakenFlushLow: pos(kraken.flushLow) ? kraken.flushLow : undefined,
    krakenExecutableBid: pos(kraken.executableBid) ? kraken.executableBid : undefined,
    referenceMids: Object.freeze(refs.map((r) => (pos(r?.usdMid) ? r.usdMid : null))),
    referenceFlushLows: Object.freeze(refs.map((r) => (pos(r?.usdWindowLow) ? r.usdWindowLow : null))),
    secondWaveAbsorbed: secondWaveAbsorbed === true,
    localLowHeld: localLowHeld === true,
    assemblerVersion: CROSS_VENUE_EPISODE_VERSION,
  });
}

// Native-unit OI contraction, verified: both readings must be finite CONTRACTS. A unit mismatch / unknown unit / absent
// reading -> null (SDR then refuses with NO_VERIFIED_OI_CONTRACTION). Positive = positions actually closed.
export function verifiedOiContractionPct({ before, now } = {}) {
  const bU = before?.unit; const nU = now?.unit; const bV = before?.value; const nV = now?.value;
  if (bU !== 'CONTRACTS' || nU !== 'CONTRACTS') return null; // never contract across unverified / mixed units
  if (!pos(bV) || !finite(nV) || nV < 0) return null;
  return round((100 * (bV - nV)) / bV);
}

// The perpetual discount in bps: index above mark = a discount (positive). null when either leg is unavailable.
export function perpDiscountBps({ mark, index } = {}) {
  if (!pos(index) || !finite(mark)) return null;
  return round((10000 * (index - mark)) / index);
}

// Assemble the SDR episode. OI contraction is unit-verified; the perp discount before/now is computed from mark vs index.
export function assembleDeleveragingEpisode({ canonicalCoin = null, decisionKnownAtTs = null, broadSelloffPct, oi = {}, liquidationTaggedSelling = false, spotVenueBidsRecovered, perp = {} } = {}) {
  const oiContractionPct = verifiedOiContractionPct(oi);
  const before = perpDiscountBps({ mark: perp.markBefore, index: perp.indexBefore });
  const now = perpDiscountBps({ mark: perp.markNow, index: perp.indexNow });
  return Object.freeze({
    canonicalCoin, decisionKnownAtTs,
    broadSelloffPct: finite(broadSelloffPct) ? broadSelloffPct : undefined,
    oiContractionPct,
    liquidationTaggedSelling: liquidationTaggedSelling === true,
    spotVenueBidsRecovered: Array.isArray(spotVenueBidsRecovered) ? Object.freeze(spotVenueBidsRecovered.slice(0, 3)) : undefined,
    perpDiscountBps: before === null || now === null ? undefined : Object.freeze({ before, now }),
    assemblerVersion: CROSS_VENUE_EPISODE_VERSION,
  });
}
