// STRATEGY 7 — Spot-Confirmed Deleveraging Reclaim shadow detector (2026-09-15): after a broad selloff with verified OI
// contraction + Kraken-Futures liquidation selling, once all three spot venues' bids recover and the perp discount
// repairs upward, FIRES (smallest bite); each missing gate REFUSES. SHADOW_ONLY, authority NONE. Pure, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSpotConfirmedDeleveragingReclaim, SDR_DETECTOR_VERSION, SDR_FAMILY, SDR_SETUP, SDR_BITE_CLASS } from '../market-lab/spot-confirmed-deleveraging-reclaim.js';

const fireEpisode = () => ({
  canonicalCoin: 'BTC', decisionKnownAtTs: 2_000,
  broadSelloffPct: 8, oiContractionPct: 7, liquidationTaggedSelling: true,
  spotVenueBidsRecovered: [true, true, true], perpDiscountBps: { before: -40, now: -8 }, // discount narrowing toward 0
});

test('SDR-1. a broad deleveraging that spot-confirms and whose perp discount repairs upward FIRES at the smallest bite', () => {
  const r = detectSpotConfirmedDeleveragingReclaim(fireEpisode());
  assert.equal(r.detectorVersion, SDR_DETECTOR_VERSION); assert.equal(r.family, SDR_FAMILY); assert.equal(r.setup, SDR_SETUP); assert.equal(r.biteClass, SDR_BITE_CLASS);
  assert.equal(r.authority, 'NONE'); assert.equal(r.purpose, 'SHADOW_ONLY_RESEARCH');
  assert.equal(r.fire, true, JSON.stringify(r.reasons)); assert.deepEqual(r.reasons, []);
  assert.equal(r.measurements.discountRepairBps, 32); assert.equal(r.measurements.spotVenuesRecovered, 3);
});

test('SDR-2. each gate refuses with its reason', () => {
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), broadSelloffPct: 2 }).reasons.includes('NO_BROAD_SELLOFF'));
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), oiContractionPct: 1 }).reasons.includes('NO_VERIFIED_OI_CONTRACTION'));
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), oiContractionPct: null }).reasons.includes('NO_VERIFIED_OI_CONTRACTION'));
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), liquidationTaggedSelling: false }).reasons.includes('NO_LIQUIDATION_TAGGED_SELLING'));
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), spotVenueBidsRecovered: [true, true, false] }).reasons.includes('SPOT_BIDS_NOT_ALL_RECOVERED'));
  // discount widened (got more negative) -> not repairing
  assert.ok(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), perpDiscountBps: { before: -8, now: -40 } }).reasons.includes('PERP_DISCOUNT_NOT_REPAIRING'));
});

test('SDR-3. absent inputs are UNKNOWN (INPUTS_UNAVAILABLE); the third venue is required (two-venue input refuses)', () => {
  assert.deepEqual(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), perpDiscountBps: null }).reasons, ['INPUTS_UNAVAILABLE']);
  assert.deepEqual(detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), spotVenueBidsRecovered: [true, true] }).reasons, ['INPUTS_UNAVAILABLE']);
  const r = detectSpotConfirmedDeleveragingReclaim({ ...fireEpisode(), broadSelloffPct: 'x' });
  assert.equal(r.fire, false); assert.deepEqual(r.reasons, ['INPUTS_UNAVAILABLE']);
});

test('SDR-4. SHADOW_ONLY record, frozen, no order/Judge authority', () => {
  const r = detectSpotConfirmedDeleveragingReclaim(fireEpisode());
  assert.equal(r.authority, 'NONE'); assert.equal(r.edgeClaim, 'NOT_MADE'); assert.match(r.law, /never an order/);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.reasons) && Object.isFrozen(r.measurements));
});
