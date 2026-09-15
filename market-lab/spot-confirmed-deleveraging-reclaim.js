// STRATEGY 7 — Spot-Confirmed Deleveraging Reclaim (SDR), the SHADOW-ONLY detector (2026-09-15). Doctrine
// (PHILOSOPHY.md §Strategy 7): family DERIVATIVE_STATE_RECLAIM, setup SPOT_CONFIRMED_DELEVERAGING_RECLAIM. After a BROAD
// selloff with VERIFIED native-unit OI CONTRACTION and LIQUIDATION-TAGGED selling on Kraken Futures' public stream, buy
// Kraken spot ONLY once all three spot venues' size-supported bids recover AND the perpetual discount repairs upward.
// Storm-prey class: SMALLEST BITE by law until paper-qualified; the last of the seven; SHADOW_ONLY behind IFR.
//
// This is the PURE detector: given the resolved deleveraging episode (plain, receipt-time-ordered facts — the caller
// derives OI contraction from repeated snapshots, tags the liquidations, walks each venue's book for the size-supported
// bid, and computes the perp discount from mark vs index), it decides FIRE / REFUSE-with-reason and returns a shadow
// record marked STORM_PREY_SMALLEST. Authority NONE, purpose SHADOW_ONLY_RESEARCH: never an order / the Judge / Watch /
// execution / a provider / a model. Pure, deterministic, imports nothing. The two senses this needed now exist
// (market-lab/providers/binance.js — the third spot venue — and market-lab/providers/kraken-futures-stream.js — the
// public liquidation-tagged trade + native-unit OI stream); market-lab/cross-venue-episode.js assembles this episode from
// them and market-lab/cross-venue-shadow.js records the shadow verdict. Live composition still waits behind the paper publish.
export const SDR_DETECTOR_VERSION = 'sdr-shadow-1';
export const SDR_FAMILY = 'DERIVATIVE_STATE_RECLAIM';
export const SDR_SETUP = 'SPOT_CONFIRMED_DELEVERAGING_RECLAIM';
export const SDR_BITE_CLASS = 'STORM_PREY_SMALLEST';
export const SDR_DEFAULTS = Object.freeze({
  minBroadSelloffPct: 5,      // the broad market must have fallen at least this much (a real deleveraging, not noise)
  minOiContractionPct: 5,     // verified native-unit open-interest contraction of at least this much (positions actually closed)
});

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 4) => Number(x.toFixed(d));

// episode: {
//   canonicalCoin, decisionKnownAtTs,
//   broadSelloffPct,          // the broad-market drop over the deleveraging window (>= 0)
//   oiContractionPct,         // VERIFIED native-unit OI contraction over the window (>= 0); null if unverifiable
//   liquidationTaggedSelling, // boolean: liquidation-tagged selling confirmed on Kraken Futures' public stream
//   spotVenueBidsRecovered,   // [bool, bool, bool] — all THREE spot venues' size-supported bids recovered (Kraken, Coinbase, Binance)
//   perpDiscountBps: { before, now }, // the perpetual discount (index-mark) in bps: repairs UPWARD when |now| < |before| (narrowing toward 0)
// }
export function detectSpotConfirmedDeleveragingReclaim(episode = {}, cfg = SDR_DEFAULTS) {
  const reasons = [];
  const {
    canonicalCoin = null, decisionKnownAtTs = null,
    broadSelloffPct, oiContractionPct, liquidationTaggedSelling = false,
    spotVenueBidsRecovered, perpDiscountBps,
  } = episode;

  const record = (fire, measurements) => Object.freeze({
    detectorVersion: SDR_DETECTOR_VERSION, family: SDR_FAMILY, setup: SDR_SETUP, biteClass: SDR_BITE_CLASS,
    canonicalCoin, decisionKnownAtTs, fire, reasons: Object.freeze([...reasons]), measurements: Object.freeze(measurements),
    authority: 'NONE', purpose: 'SHADOW_ONLY_RESEARCH', edgeClaim: 'NOT_MADE',
    law: 'after a broad selloff with verified native-unit OI contraction and Kraken-Futures liquidation selling, buy spot only once all three spot venues size-supported bids recover and the perp discount repairs upward; smallest bite; record only, never an order',
  });

  const bidsOk = Array.isArray(spotVenueBidsRecovered) && spotVenueBidsRecovered.length === 3 && spotVenueBidsRecovered.every((x) => typeof x === 'boolean');
  const discOk = perpDiscountBps && finite(perpDiscountBps.before) && finite(perpDiscountBps.now);
  if (!finite(broadSelloffPct) || !bidsOk || !discOk) {
    reasons.push('INPUTS_UNAVAILABLE');
    return record(false, { broadSelloffPct: finite(broadSelloffPct) ? round(broadSelloffPct) : null, oiContractionPct: finite(oiContractionPct) ? round(oiContractionPct) : null, discountRepairBps: null });
  }

  // 1) a real broad selloff
  if (broadSelloffPct < cfg.minBroadSelloffPct) reasons.push('NO_BROAD_SELLOFF');
  // 2) VERIFIED native-unit OI contraction (unverifiable -> refuse, never assumed)
  if (!finite(oiContractionPct) || oiContractionPct < cfg.minOiContractionPct) reasons.push('NO_VERIFIED_OI_CONTRACTION');
  // 3) liquidation-tagged selling confirmed on the Kraken-Futures public stream
  if (liquidationTaggedSelling !== true) reasons.push('NO_LIQUIDATION_TAGGED_SELLING');
  // 4) ALL THREE spot venues' size-supported bids recovered
  if (!spotVenueBidsRecovered.every((x) => x === true)) reasons.push('SPOT_BIDS_NOT_ALL_RECOVERED');
  // 5) the perpetual discount repairs UPWARD (its magnitude narrows toward zero)
  const discountRepairBps = round(Math.abs(perpDiscountBps.before) - Math.abs(perpDiscountBps.now));
  if (!(discountRepairBps > 0)) reasons.push('PERP_DISCOUNT_NOT_REPAIRING');

  return record(reasons.length === 0, { broadSelloffPct: round(broadSelloffPct), oiContractionPct: finite(oiContractionPct) ? round(oiContractionPct) : null, discountRepairBps, spotVenuesRecovered: spotVenueBidsRecovered.filter(Boolean).length });
}
