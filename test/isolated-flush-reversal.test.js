// STRATEGY 6 — Isolated Flush Reversal shadow detector (2026-09-15): a Kraken-only flush that the references held, once
// Kraken repairs >=80% of the gap with a second wave absorbed and the low holding, FIRES; every missing gate REFUSES with
// its reason. SHADOW_ONLY, authority NONE. Pure, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIsolatedFlushReversal, IFR_DETECTOR_VERSION, IFR_FAMILY, IFR_SETUP } from '../market-lab/isolated-flush-reversal.js';

// a clean FIRE episode: reference mid 100; Kraken flushed to 90 (10% Kraken-only), references held ~100; the executable
// bid has repaired to 99 (recovery-ownership (99-90)/(100-90) = 0.90 >= 0.80); second wave absorbed; low held.
const fireEpisode = () => ({
  canonicalCoin: 'BTC', decisionKnownAtTs: 1_000,
  preFlushReferenceMid: 100, krakenFlushLow: 90, krakenExecutableBid: 99,
  referenceMids: [100, 100], referenceFlushLows: [99.8, 99.9], secondWaveAbsorbed: true, localLowHeld: true,
});

test('IFR-1. a Kraken-only flush repaired past 0.80 ownership with absorption and the low holding FIRES', () => {
  const r = detectIsolatedFlushReversal(fireEpisode());
  assert.equal(r.detectorVersion, IFR_DETECTOR_VERSION); assert.equal(r.family, IFR_FAMILY); assert.equal(r.setup, IFR_SETUP);
  assert.equal(r.authority, 'NONE'); assert.equal(r.purpose, 'SHADOW_ONLY_RESEARCH'); assert.equal(r.edgeClaim, 'NOT_MADE');
  assert.equal(r.fire, true, JSON.stringify(r.reasons)); assert.deepEqual(r.reasons, []);
  assert.equal(r.measurements.flushDropPct, 10); assert.equal(r.measurements.recoveryOwnership, 0.9);
});

test('IFR-2. each gate refuses with its reason', () => {
  // shallow flush: 100 -> 98 is only 2% (< 3% minFlush)
  assert.deepEqual(detectIsolatedFlushReversal({ ...fireEpisode(), krakenFlushLow: 98, krakenExecutableBid: 99.6 }).reasons.includes('NO_SHARP_FLUSH'), true);
  // references ALSO dropped (not isolated): a reference fell to 95 (5% > 1%)
  assert.equal(detectIsolatedFlushReversal({ ...fireEpisode(), referenceMids: [95, 100], referenceFlushLows: [95, 100] }).reasons.includes('NOT_ISOLATED_REFERENCES_ALSO_DROPPED'), true);
  // no repair yet: executable bid still at the flush low
  assert.equal(detectIsolatedFlushReversal({ ...fireEpisode(), krakenExecutableBid: 90 }).reasons.includes('NO_REPAIR_YET'), true);
  // recovery ownership below 0.80: bid at 94 -> (94-90)/(100-90)=0.4
  const low = detectIsolatedFlushReversal({ ...fireEpisode(), krakenExecutableBid: 94 });
  assert.equal(low.fire, false); assert.equal(low.measurements.recoveryOwnership, 0.4); assert.equal(low.reasons.includes('RECOVERY_OWNERSHIP_BELOW_MIN'), true);
  // absorption not confirmed / local low failed
  assert.equal(detectIsolatedFlushReversal({ ...fireEpisode(), secondWaveAbsorbed: false }).reasons.includes('SECOND_WAVE_ABSORPTION_NOT_CONFIRMED'), true);
  assert.equal(detectIsolatedFlushReversal({ ...fireEpisode(), localLowHeld: false }).reasons.includes('LOCAL_LOW_FAILED'), true);
});

test('IFR-3. absent/invalid inputs are UNKNOWN (refuse INPUTS_UNAVAILABLE), never guessed; only two reference venues satisfy the law', () => {
  const r = detectIsolatedFlushReversal({ preFlushReferenceMid: 100, krakenFlushLow: null, krakenExecutableBid: 99, referenceMids: [100, 100] });
  assert.equal(r.fire, false); assert.deepEqual(r.reasons, ['INPUTS_UNAVAILABLE']); assert.equal(r.measurements.recoveryOwnership, null);
  // only one reference venue present -> INPUTS_UNAVAILABLE (the law requires two)
  assert.deepEqual(detectIsolatedFlushReversal({ ...fireEpisode(), referenceMids: [100] }).reasons, ['INPUTS_UNAVAILABLE']);
});

test('IFR-4. the detector never carries order/Judge authority (SHADOW_ONLY record only)', () => {
  const r = detectIsolatedFlushReversal(fireEpisode());
  assert.equal(r.authority, 'NONE'); assert.match(r.law, /never an order/);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.reasons) && Object.isFrozen(r.measurements));
});
