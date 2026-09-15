// STRATEGY 6 — Isolated Flush Reversal (IFR), the SHADOW-ONLY detector (2026-09-15). Doctrine (PHILOSOPHY.md §Strategy 6):
// family CROSS_VENUE_DISLOCATION, setup ISOLATED_FLUSH_REVERSAL. Buy a sharp KRAKEN-ONLY selloff ONLY AFTER Kraken starts
// repairing it while the same asset HOLDS on two reference venues (Coinbase + Binance public books, read-only,
// receipt-time ordered); recovery measured at the SIZE-AWARE EXECUTABLE BID; a SECOND-WAVE ABSORPTION test;
// RECOVERY-OWNERSHIP >= 0.80; exit when the gap repairs, the references confirm the drop, or the local low fails.
//
// This is the PURE detector: given a resolved cross-venue dislocation episode (plain, receipt-time-ordered numbers — the
// caller extracts the size-aware executable bid by walking the book), it decides FIRE or REFUSE-with-reason and returns a
// shadow record. It is SHADOW_ONLY / authority NONE / purpose RESEARCH: it can never reach an order, the Judge, Watch,
// execution, a provider or a model — it only records where the strategy WOULD have fired, for episode / refusal /
// counterfactual study, exactly like the forward-shadow lane. Pure and deterministic (no clock, I/O, or randomness),
// imports nothing. The live senses now exist (market-lab/providers/binance.js public book + coinbase + kraken-spot) and
// market-lab/cross-venue-episode.js assembles this episode from them; the shadow record is written by
// market-lab/cross-venue-shadow.js. Live composition into the runtime loop still waits behind the paper publish.
export const IFR_DETECTOR_VERSION = 'ifr-shadow-1';
export const IFR_FAMILY = 'CROSS_VENUE_DISLOCATION';
export const IFR_SETUP = 'ISOLATED_FLUSH_REVERSAL';
export const IFR_DEFAULTS = Object.freeze({
  minFlushDropPct: 3,        // the Kraken flush must be at least this far below the pre-flush reference mid (a SHARP selloff)
  maxReferenceDropPct: 1,    // each reference venue must have held within this of its pre-flush mid (the flush is KRAKEN-ONLY)
  recoveryOwnershipMin: 0.80,// the executable bid must have repaired at least this fraction of the dislocation gap
});

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const pos = (x) => finite(x) && x > 0;
const round = (x, d = 4) => Number(x.toFixed(d));

// episode: {
//   canonicalCoin, decisionKnownAtTs,
//   preFlushReferenceMid,     // the reference mid just before the flush (the baseline the venues agreed on)
//   krakenFlushLow,           // Kraken's local low during the flush (the dislocation trough)
//   krakenExecutableBid,      // the CURRENT size-aware executable bid on Kraken (the caller walked the book for the bite size)
//   referenceMids,            // [coinbaseMid, binanceMid] CURRENT — the same asset on the two reference venues, receipt-time ordered
//   referenceFlushLows,       // [coinbaseLow, binanceLow] during the same window — to prove the references HELD (Kraken-only)
//   secondWaveAbsorbed,       // boolean: a second-wave dip after the first repair was absorbed (the book held), never assumed
//   localLowHeld,             // boolean: the local low has NOT failed since the repair began (a live exit condition, gate here)
// }
export function detectIsolatedFlushReversal(episode = {}, cfg = IFR_DEFAULTS) {
  const reasons = [];
  const {
    canonicalCoin = null, decisionKnownAtTs = null,
    preFlushReferenceMid, krakenFlushLow, krakenExecutableBid,
    referenceMids = [], referenceFlushLows = [], secondWaveAbsorbed = false, localLowHeld = false,
  } = episode;

  const record = (fire, measurements) => Object.freeze({
    detectorVersion: IFR_DETECTOR_VERSION, family: IFR_FAMILY, setup: IFR_SETUP,
    canonicalCoin, decisionKnownAtTs, fire, reasons: Object.freeze([...reasons]), measurements: Object.freeze(measurements),
    authority: 'NONE', purpose: 'SHADOW_ONLY_RESEARCH', edgeClaim: 'NOT_MADE',
    law: 'buy a KRAKEN-ONLY flush only after Kraken repairs it while two reference venues hold; recovery at the size-aware executable bid; recovery-ownership >= 0.80; record only, never an order',
  });

  // inputs must be real numbers; anything absent is UNKNOWN, never guessed
  if (!pos(preFlushReferenceMid) || !pos(krakenFlushLow) || !pos(krakenExecutableBid) || !Array.isArray(referenceMids) || referenceMids.length < 2 || !referenceMids.every(pos)) {
    reasons.push('INPUTS_UNAVAILABLE');
    return record(false, { flushDropPct: null, referenceDropsPct: null, recoveryOwnership: null });
  }

  // 1) a SHARP flush: Kraken's trough is >= minFlushDropPct below the pre-flush reference mid
  const flushDropPct = round(100 * (preFlushReferenceMid - krakenFlushLow) / preFlushReferenceMid);
  if (flushDropPct < cfg.minFlushDropPct) reasons.push('NO_SHARP_FLUSH');

  // 2) KRAKEN-ONLY: every reference venue held within maxReferenceDropPct of the baseline (both current mid and its window low)
  const refLows = Array.isArray(referenceFlushLows) && referenceFlushLows.length === referenceMids.length ? referenceFlushLows : referenceMids;
  const referenceDropsPct = referenceMids.map((mid, i) => {
    const low = pos(refLows[i]) ? Math.min(refLows[i], mid) : mid;
    return round(100 * (preFlushReferenceMid - low) / preFlushReferenceMid);
  });
  if (referenceDropsPct.some((d) => d > cfg.maxReferenceDropPct)) reasons.push('NOT_ISOLATED_REFERENCES_ALSO_DROPPED');

  // 3) repair underway: the executable bid has lifted off the flush low
  if (!(krakenExecutableBid > krakenFlushLow)) reasons.push('NO_REPAIR_YET');

  // 4) recovery-ownership: the fraction of the dislocation gap (flush low -> reference) the executable bid has repaired
  const refMidAvg = referenceMids.reduce((n, x) => n + x, 0) / referenceMids.length;
  const gap = refMidAvg - krakenFlushLow;
  const recoveryOwnership = gap > 0 ? round((krakenExecutableBid - krakenFlushLow) / gap) : null;
  if (recoveryOwnership === null || recoveryOwnership < cfg.recoveryOwnershipMin) reasons.push('RECOVERY_OWNERSHIP_BELOW_MIN');

  // 5) the second-wave absorption test and the local-low-held gate (both observed, never assumed)
  if (secondWaveAbsorbed !== true) reasons.push('SECOND_WAVE_ABSORPTION_NOT_CONFIRMED');
  if (localLowHeld !== true) reasons.push('LOCAL_LOW_FAILED');

  return record(reasons.length === 0, { flushDropPct, referenceDropsPct: Object.freeze(referenceDropsPct), recoveryOwnership, refMidAvg: round(refMidAvg) });
}
