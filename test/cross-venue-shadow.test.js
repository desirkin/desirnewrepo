// STRATEGY 6 / 7 WIRING (SHADOW_ONLY) — the pure episode assembler + shadow recorder. No network, no clock, no order verb.
// The Binance frozen-basis stablecoin-health gate and the unit-verified OI contraction are shown flowing through to the
// detectors' fail-closed refusals; the shadow record is authority NONE and structurally fenced from the Judge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usdReference, assembleIsolatedFlushEpisode, verifiedOiContractionPct, perpDiscountBps, assembleDeleveragingEpisode } from '../market-lab/cross-venue-episode.js';
import { recordCrossVenueShadow, maturedOutcome } from '../market-lab/cross-venue-shadow.js';
import { IFR_SETUP } from '../market-lab/isolated-flush-reversal.js';
import { SDR_SETUP } from '../market-lab/spot-confirmed-deleveraging-reclaim.js';

const HEALTHY = { pegDeviationBps: 4, ageMs: 60_000 };
const DEPEGGED = { pegDeviationBps: 300, ageMs: 60_000 };

test('CVS-1. usdReference: USD venues pass through; a Binance USDT reference is frozen-basis health-gated (unhealthy -> null)', () => {
  assert.equal(usdReference({ venue: 'kraken', quote: 'USD', mid: 100 }).usdMid, 100);
  assert.equal(usdReference({ venue: 'coinbase', quote: 'USD', mid: 99.9 }).usdMid, 99.9);
  const good = usdReference({ venue: 'binance', quote: 'USDT', mid: 100, windowLow: 99.8, stablecoinHealth: HEALTHY });
  assert.equal(good.usdMid, 100); assert.equal(good.usdWindowLow, 99.8); assert.equal(good.stablecoinHealthy, true);
  const bad = usdReference({ venue: 'binance', quote: 'USDT', mid: 100, stablecoinHealth: DEPEGGED });
  assert.equal(bad.usdMid, null); assert.equal(bad.stablecoinHealthy, false); assert.equal(bad.stablecoinReason, 'STABLECOIN_DEPEGGED');
});

test('CVS-2. IFR assembly + record: a clean Kraken-only flush-and-repair FIRES; an unhealthy Binance reference fails the episode closed', () => {
  const references = [usdReference({ venue: 'coinbase', quote: 'USD', mid: 100, windowLow: 100 }), usdReference({ venue: 'binance', quote: 'USDT', mid: 100, windowLow: 100, stablecoinHealth: HEALTHY })];
  const ep = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', decisionKnownAtTs: 1, kraken: { preFlushReferenceMid: 100, flushLow: 96, executableBid: 99.5 }, references, secondWaveAbsorbed: true, localLowHeld: true });
  assert.deepEqual(ep.referenceMids, [100, 100]);
  const rec = recordCrossVenueShadow({ setup: IFR_SETUP, episode: ep, recordedAtTs: 5 });
  assert.equal(rec.fire, true); assert.equal(rec.authority, 'NONE'); assert.equal(rec.counterfactual.wouldHaveFired, true);
  assert.equal(rec.counterfactual.entryReference, 99.5, 'the entry reference is the size-aware executable bid');
  assert.equal(rec.counterfactual.outcome, 'PENDING_NO_PATH'); assert.equal(rec.fenced, 'NEVER_REACHES_JUDGE_WATCH_EXECUTION_OR_ORDER');
  // an unhealthy Binance basis => a null reference mid => INPUTS_UNAVAILABLE (the de-peg never reads as a Kraken-only flush)
  const badRefs = [usdReference({ venue: 'coinbase', quote: 'USD', mid: 100, windowLow: 100 }), usdReference({ venue: 'binance', quote: 'USDT', mid: 100, stablecoinHealth: DEPEGGED })];
  const epBad = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', kraken: { preFlushReferenceMid: 100, flushLow: 96, executableBid: 99.5 }, references: badRefs, secondWaveAbsorbed: true, localLowHeld: true });
  assert.deepEqual(epBad.referenceMids, [100, null]);
  const recBad = recordCrossVenueShadow({ setup: IFR_SETUP, episode: epBad });
  assert.equal(recBad.fire, false); assert.ok(recBad.reasons.includes('INPUTS_UNAVAILABLE')); assert.equal(recBad.counterfactual.entryReference, null);
});

test('CVS-3. SDR assembly: OI contraction is unit-verified (CONTRACTS only) and the perp discount is computed; a clean deleveraging reclaim FIRES', () => {
  assert.equal(verifiedOiContractionPct({ before: { value: 1000, unit: 'CONTRACTS' }, now: { value: 900, unit: 'CONTRACTS' } }), 10);
  assert.equal(verifiedOiContractionPct({ before: { value: 1000, unit: 'UNKNOWN' }, now: { value: 900, unit: 'CONTRACTS' } }), null, 'an unverified unit never contracts');
  assert.equal(verifiedOiContractionPct({ before: { value: 1000, unit: 'CONTRACTS' }, now: { value: 900, unit: 'BASE' } }), null, 'mixed units never contract');
  assert.equal(perpDiscountBps({ mark: 99, index: 100 }), 100); assert.equal(perpDiscountBps({ mark: 99, index: null }), null);
  const ep = assembleDeleveragingEpisode({ canonicalCoin: 'BTC', decisionKnownAtTs: 2, broadSelloffPct: 6, oi: { before: { value: 1000, unit: 'CONTRACTS' }, now: { value: 900, unit: 'CONTRACTS' } }, liquidationTaggedSelling: true, spotVenueBidsRecovered: [true, true, true], perp: { markBefore: 99, indexBefore: 100, markNow: 99.9, indexNow: 100 } });
  assert.equal(ep.oiContractionPct, 10); assert.deepEqual(ep.perpDiscountBps, { before: 100, now: 10 });
  const rec = recordCrossVenueShadow({ setup: SDR_SETUP, episode: ep, recordedAtTs: 9 });
  assert.equal(rec.fire, true); assert.equal(rec.family, 'DERIVATIVE_STATE_RECLAIM'); assert.equal(rec.measurements.discountRepairBps, 90);
  // an unverified OI unit makes SDR refuse — never a guessed contraction
  const epBad = assembleDeleveragingEpisode({ canonicalCoin: 'BTC', broadSelloffPct: 6, oi: { before: { value: 1000, unit: 'UNKNOWN' }, now: { value: 900, unit: 'CONTRACTS' } }, liquidationTaggedSelling: true, spotVenueBidsRecovered: [true, true, true], perp: { markBefore: 99, indexBefore: 100, markNow: 99.9, indexNow: 100 } });
  assert.equal(epBad.oiContractionPct, null);
  const recBad = recordCrossVenueShadow({ setup: SDR_SETUP, episode: epBad });
  assert.equal(recBad.fire, false); assert.ok(recBad.reasons.includes('NO_VERIFIED_OI_CONTRACTION'));
});

test('CVS-4. counterfactual maturation: a forward path labels a fired shadow FAVORABLE / ADVERSE / NEUTRAL; no path stays PENDING', () => {
  assert.equal(maturedOutcome(null), 'PENDING_NO_PATH');
  assert.equal(maturedOutcome({ maxFavorablePct: 3, maxAdversePct: -0.5 }), 'MATURED_FAVORABLE');
  assert.equal(maturedOutcome({ maxFavorablePct: 0.4, maxAdversePct: -2 }), 'MATURED_ADVERSE');
  assert.equal(maturedOutcome({ maxFavorablePct: 0.2, maxAdversePct: -0.2 }), 'MATURED_NEUTRAL');
  const references = [usdReference({ venue: 'coinbase', quote: 'USD', mid: 100, windowLow: 100 }), usdReference({ venue: 'binance', quote: 'USDT', mid: 100, windowLow: 100, stablecoinHealth: HEALTHY })];
  const ep = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', kraken: { preFlushReferenceMid: 100, flushLow: 96, executableBid: 99.5 }, references, secondWaveAbsorbed: true, localLowHeld: true });
  const rec = recordCrossVenueShadow({ setup: IFR_SETUP, episode: ep, forwardPath: { maxFavorablePct: 2.5, maxAdversePct: -0.3 }, recordedAtTs: 7 });
  assert.equal(rec.counterfactual.outcome, 'MATURED_FAVORABLE'); assert.deepEqual(rec.counterfactual.forwardPath, { maxFavorablePct: 2.5, maxAdversePct: -0.3 });
  assert.throws(() => recordCrossVenueShadow({ setup: 'NOPE', episode: ep }), /unknown setup/);
});

test('CVS-5 (READINESS b). the IFR runs with the REACHABLE references only, >= 1: three venues, one venue (Binance/Bitstamp geo-blocked at boot) still FIRES, and the episode + shadow record carry a reference-coverage note; zero reachable fails closed', () => {
  const ref = (venue) => usdReference({ venue, quote: 'USD', mid: 100, windowLow: 100 });
  const kraken = { preFlushReferenceMid: 100, flushLow: 96, executableBid: 99.5 };
  // three reachable references: the strongest isolation claim
  const three = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', kraken, references: [ref('coinbase'), ref('binance'), ref('bitstamp')], secondWaveAbsorbed: true, localLowHeld: true });
  assert.deepEqual(three.referenceMids, [100, 100, 100]);
  assert.equal(three.referenceCoverage.reachableCount, 3); assert.deepEqual(three.referenceCoverage.reachableVenues, ['coinbase', 'binance', 'bitstamp']); assert.equal(three.referenceCoverage.sufficient, true); assert.deepEqual(three.referenceCoverage.blocked, []);
  assert.equal(recordCrossVenueShadow({ setup: IFR_SETUP, episode: three }).fire, true);
  // ONE reachable reference (Coinbase), Binance + Bitstamp geo-blocked at boot: the detector still runs and FIRES, and the
  // coverage note discloses the weaker isolation (1 reachable, 2 blocked BLOCKED_GEOGRAPHY) at both the episode and record.
  const one = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', kraken, references: [ref('coinbase')], blockedReferences: [{ venue: 'binance', reason: 'BLOCKED_GEOGRAPHY' }, { venue: 'bitstamp', reason: 'BLOCKED_GEOGRAPHY' }], secondWaveAbsorbed: true, localLowHeld: true });
  assert.deepEqual(one.referenceMids, [100]);
  assert.equal(one.referenceCoverage.reachableCount, 1); assert.deepEqual(one.referenceCoverage.reachableVenues, ['coinbase']); assert.equal(one.referenceCoverage.sufficient, true);
  assert.deepEqual(one.referenceCoverage.blocked, [{ venue: 'binance', reason: 'BLOCKED_GEOGRAPHY' }, { venue: 'bitstamp', reason: 'BLOCKED_GEOGRAPHY' }]);
  assert.match(one.referenceCoverage.note, /1 reachable reference venue.*coinbase.*binance:BLOCKED_GEOGRAPHY/);
  const rec = recordCrossVenueShadow({ setup: IFR_SETUP, episode: one, recordedAtTs: 5 });
  assert.equal(rec.fire, true, 'one reachable reference is enough to run the detector'); assert.equal(rec.counterfactual.entryReference, 99.5);
  assert.equal(rec.referenceCoverage.reachableCount, 1); assert.equal(rec.referenceCoverage.blocked.length, 2, 'the coverage flag rides to the top of the dossier');
  // ZERO reachable references (every venue geo-blocked): the episode is fail-closed, never a fabricated isolation
  const none = assembleIsolatedFlushEpisode({ canonicalCoin: 'SOL', kraken, references: [], blockedReferences: [{ venue: 'coinbase', reason: 'BLOCKED_GEOGRAPHY' }, { venue: 'binance', reason: 'BLOCKED_GEOGRAPHY' }, { venue: 'bitstamp', reason: 'BLOCKED_GEOGRAPHY' }], secondWaveAbsorbed: true, localLowHeld: true });
  assert.equal(none.referenceCoverage.reachableCount, 0); assert.equal(none.referenceCoverage.sufficient, false);
  const recNone = recordCrossVenueShadow({ setup: IFR_SETUP, episode: none });
  assert.equal(recNone.fire, false); assert.ok(recNone.reasons.includes('INPUTS_UNAVAILABLE'), 'no reachable reference never fires');
});
