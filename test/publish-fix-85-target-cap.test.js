// PUBLISH-FIX-85 (2026-09-20) — the target-cap law. The owner's records: ARB/USD MICRO_BITE passed every gate twice today and died at
// sizing because the scenario target was capped to a swing high one tick above the entry ("target 0.2125 capped at 0.2125"); AKE on
// 09-19 and the bite drill's MICRO_BITE died the sibling way: the 20-bar high (its raw target) was already below the entry. Two laws:
// (1) a swing high nearer the entry than REWARD_RISK_MIN × the stop distance can never size, so it is not a target — the cap looks
// past it; (2) a setup whose own target the price has already run past uses its projection (MICRO_BITE: one 20-bar range above the
// 20-bar high) — a setup without a projection keeps its raw target and is refused at sizing with reasons, exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestResistanceAbove } from '../judge/features.js';
import { scenarioTarget, minTargetDistance } from '../judge/setups.js';

const T0 = 1_760_000_000_000;
function bars({ n = 61, close = 100, spikes = {} } = {}) {
  const out = []; for (let i = 0; i < n; i += 1) { const hi = spikes[i] !== undefined ? spikes[i] : close + 0.5; out.push({ periodStartTs: T0 - (n - i) * 60_000, periodEndTs: T0 - (n - i - 1) * 60_000, open: close, high: hi, low: close - 0.5, close, volumeQuote: 1000, volumeBase: 10, closed: true }); } return out;
}

test('FIX85-T1. minTargetDistance is REWARD_RISK_MIN × (entry − stop); 0 when the stop is unknown or not below the entry', () => {
  assert.equal(minTargetDistance('100', '90'), 15);
  assert.equal(minTargetDistance('0.2125', '0.2100'), (0.2125 - 0.21) * 1.5);
  assert.equal(minTargetDistance('100', null), 0); assert.equal(minTargetDistance('100', '100'), 0); assert.equal(minTargetDistance('100', '101'), 0);
});

test('FIX85-T2. a swing high inside the minimum distance is skipped; the nearest swing beyond it is the resistance; none → null', () => {
  const b = bars({ spikes: { 30: 101, 45: 120 } }); // two confirmed swings: 101 (one tick above a 100.9 entry) and 120
  assert.equal(nearestResistanceAbove(b, 100.9).price, 101, 'without the law the nearest swing wins (unchanged default)');
  assert.equal(nearestResistanceAbove(b, 100.9, { minAbove: 15 }).price, 120, 'with a 15 minimum the one-tick swing is noise');
  assert.equal(nearestResistanceAbove(b, 100.9, { minAbove: 30 }), null, 'no swing far enough → no cap');
});

test('FIX85-T3 (ARB). the scenario target is not capped to a swing the reward law could never accept', () => {
  const b = bars({ spikes: { 30: 101, 45: 120 } });
  const frozen = { scenarioRaw: '130', structuralStop: '90' }; // entry 100.9, stop 90 → risk 10.9 → a target needs ≥ 16.35 above
  const before = scenarioTarget({ scenarioRaw: '130', structuralStop: null }, b, '100.9', T0); // stop unknown → old behaviour
  assert.equal(before.target, '101'); assert.equal(before.cappedBy.price, '101');
  const t = scenarioTarget(frozen, b, '100.9', T0);
  assert.equal(t.target, '120', 'capped to the swing that can size, not the one a tick away'); assert.equal(t.cappedBy.price, '120');
});

test('FIX85-T4 (AKE / the drill). a MICRO_BITE whose 20-bar high is behind the entry projects one range above it; without a projection the raw target stands', () => {
  const b = bars({});
  const exhausted = { scenarioRaw: '100200', scenarioProjected: '104200', structuralStop: '99800' }; // h20 100200, l20 96200 → h20 + 4000
  const t = scenarioTarget(exhausted, b, '100410', T0);
  assert.equal(t.target, '104200'); assert.equal(t.cappedBy, null);
  const fine = scenarioTarget({ scenarioRaw: '100200', scenarioProjected: '104200', structuralStop: '99200' }, b, '99500', T0); // risk 300 → needs 450; the raw target is 700 above
  assert.equal(fine.target, '100200', 'a raw target far enough above the entry is untouched');
  const noProjection = scenarioTarget({ scenarioRaw: '100200', structuralStop: '99800' }, b, '100410', T0);
  assert.equal(noProjection.target, '100200', 'no projection → raw stands and sizing refuses it with reasons, as before');
});
